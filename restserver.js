"use strict";

var accesslog = require('accesslog');
var url = require("url");
var restify = require("restify");
var fs = require("fs");
var async = require("async");
var Common = require('./common.js');
var logger = Common.logger;
var ThreadedLogger = require('./ThreadedLogger.js');

var machineModule = require('./machine.js');
var userModule = require('./user.js');
var appModule = require('./app.js');
var filesModule = require('./files.js');
var firewallModule = require('./firewall.js');
var createNewUserTarGzModule = require('./createNewUserTarGz.js');

var filterModule = require('permission-parser');
var filterOpts = {
    loge: logger.error
};
var filterObj = new filterModule([], filterOpts);
var filterFile = "./parameters-map.js";
fs.watchFile(filterFile, {
    persistent : false,
    interval : 5007
}, function(curr, prev) {
    logger.info(filterFile + ' been modified');
    refresh_filter();
});

var refresh_filter = function() {
    try {
        delete require.cache[require.resolve(filterFile)];
    } catch(e) {}

    var obj;
    try {
        obj = require(filterFile);
    } catch(e) {
        logger.error('Error: Cannot load ' + filterFile + ' file, err: ' + e);
        return;
    }
    console.log("obj: " + JSON.stringify(obj));
    filterObj.reload(obj.rules, {permittedMode: obj.permittedMode});
};
refresh_filter();

var mainFunction = function(err, firstTimeLoad) {
    if(err) {
        console.log("Fatal Error: " + err);
        Common.quit();
        return;
    }

    if(!firstTimeLoad)// execute the following code only in the first time
        return;

    var initPortListener = function(listenAddress, callback) {
        async.waterfall(
            [
                function(callback) {
                    var urlObj = url.parse(listenAddress);
                    // logger.info("protocol: "+urlObj.protocol+", hostname:"+urlObj.hostname+", port: "+urlObj.port);
                    var isSSL = urlObj.protocol === "https:";
                    var port = urlObj.port;
                    if(!port)
                        port = ( isSSL ? 443 : 80);
                    var host = urlObj.hostname;
                    callback(null, host, port, isSSL);
                },
                function(host, port, isSSL, callback) {
                    if(isSSL) {
                        readCerts(function(err, opts) {
                            if(err) {
                                callback(err);
                                return;
                            } else {
                                opts.requestCert = true;
                                opts.rejectUnauthorized = true;
                                callback(null, host, port, opts);
                            }
                        });
                    } else {
                        callback(null, host, port, null);
                    }
                },
                function(host, port, server_options, callback) {
                    var myserver = restify.createServer(server_options);
                    buildServerObject(myserver);
                    myserver.listen(port, host, function() {
                        logger.info('%s listening at %s', myserver.name, myserver.url);
                        callback(null);
                    });
                    var closeListener = function(callback) {
                        myserver.close(callback);
                    };
                    Common.exitJobs.push(closeListener);
                }
            ], function(err) {
                if(err) {
                    logger.error("Cannot open listener for " + listenAddress + ", err: " + err);
                }
                if(typeof callback === "function") callback(err);
            }
        );
    };
    var readCerts = function(callback) {
        if(!Common.sslCerts || !Common.sslCerts.ca || !Common.sslCerts.cert || !Common.sslCerts.key) return callback("bad parameter Common.sslCerts");
        var sslCerts = {};
        async.forEachOf(
            Common.sslCerts,
            function(item, key, callback) {
                fs.readFile(item, function(err, data) {
                    if(err) {
                        logger.error("Cannot read " + item + " file, err: " + err);
                    } else {
                        sslCerts[key] = data;
                    }
                    callback(err);
                });
            },
            function(err) {
                callback(err, sslCerts);
            }
        );
    };

    async.eachSeries(
        Common.listenAddresses,
        initPortListener
    );

    process.on('SIGINT', function() {
        logger.info("restserver caught interrupt signal");
        Common.quit();
    });
};

var accesslogger = accesslog({
    path: './log/access_log.log'
});

function nocache(req, res, next) {
    if(!req.headers['range']) {
        res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        res.header('Expires', '-1');
        res.header('Pragma', 'no-cache');
    }
    next();
}

function validateCertificate(req, res, next) {
    var certObj;
    if(res.socket.authorized) {
        certObj = res.socket.getPeerCertificate(true);
        //sometime (next time: 2nd, 3rd) certObj come without certObj.issuerCertificate, so we keep fingerprints of known certificates
        if(Common.managementCertsFingerprint.indexOf(certObj.fingerprint) !== -1) {
            //Certificate in list of known certificates
            next();
        } else if(certObj.issuerCertificate && Common.managementCertIssuerFingerprint && (certObj.issuerCertificate.fingerprint === Common.managementCertIssuerFingerprint)) {
            //Certificate is not in list of known certificates, but it's issuer is known issuer, then add certificate to list of  known certificates
            Common.managementCertsFingerprint.push(certObj.fingerprint);
            next();
        } else {
            logger.error("Reject try access to " + req.url + " with wrong nubo certificate: " + JSON.stringify(certObj.subject));
            res.send(401);
        }
    } else {
        // https listener request authorization with certificate, so if it is not authorized, it can been only http listener
        next();
    }
}

function buildServerObject(server) {

    server.on('uncaughtException', function(request, response, route, error) {
        logger.error("Exception in http server: request url: " + request.url + " error: " + JSON.stringify(error && error.stack || error));
        try {
            response.send(error);
        } catch(e) {
            logger.warn("response already done");
        }
        return true;
    });
    server.use(validateCertificate);
    server.use(restify.queryParser());
    server.use(filterObj.useHandler);
    server.use(function(req, res, next) {
        req.realIP = req.headers['x-real-ip'] || req.connection.remoteAddress;
        next();

    });
    server.use(accesslogger);
    // server.use(restify.gzipResponse());
    server.use(nocache);
    server.get("/", function(req, res) {res.end("OK");});
    server.get("/startPlatform", machineModule.startPlatformGet);
    server.post("/startPlatform", machineModule.startPlatformPost);
    server.get("/killPlatform", machineModule.killPlatform);
    server.post("/attachUser", userModule.attachUser);
    server.get("/detachUser", userModule.detachUser);
    server.get("/installApk", appModule.installApk);
    server.post("/attachApps", appModule.attachApps);
    server.get("/getPackagesList", appModule.getPackagesList);
    server.post("/refreshMedia", filesModule.refreshMedia);
    server.get("/checkPlatformStatus", machineModule.checkPlatformStatus);
    server.post("/applyFirewall", firewallModule.post);
    server.get("/createNewUserTarGz",createNewUserTarGzModule.create);
}

Common.loadCallback = mainFunction;
if(module) {
    module.exports = {mainFunction: mainFunction};
}
