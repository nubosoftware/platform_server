"use strict";

var accesslog = require('accesslog');
var url = require("url");
var restify = require("restify");
var fs = require("fs");
var async = require("async");
var Common = require('./common.js');
var logger = Common.getLogger(__filename);
var ThreadedLogger = require('./ThreadedLogger.js');

var machineModule = require('./machine.js');
var userModule = require('./user.js');
var appModule = require('./app.js');
var filesModule = require('./files.js');
var firewallModule = require('./firewall.js');
var createNewUserTarGzModule = require('./createNewUserTarGz.js');
var jwt = require('jsonwebtoken');
const pem = require('pem');
var vpn = require('./vpn.js');
var validate = require('validate.js');
const axios = require('axios');

var filterModule = require('@nubosoftware/permission-parser');


var filterLog = function(msg) {
    logger.info(msg);
}

var urlFilterOpts = {
    loge: logger.error,
    //logd: filterLog,
    mode: filterModule.mode.URL
};

var bodyFilterOpts = {
    loge: logger.error,
    //logd: filterLog,
    mode: filterModule.mode.BODY
};
var urlFilterObj = new filterModule.filter([], urlFilterOpts,validate);
var bodyFilterObj = new filterModule.filter([], bodyFilterOpts,validate);
var filterFile = "./parameters-map.js";

var refresh_filter = function() {    

    var obj;
    try {
        obj = require("./parameters-map.js");
    } catch (e) {
        logger.error('Error: Cannot load ' + filterFile + ' file, err: ' + e);
        return;
    }
    //console.log("parameters-map: " + JSON.stringify(obj));

    var permittedMode = Common.parametersMapPermittedMode ? Common.parametersMapPermittedMode : false;

    urlFilterObj.reload(obj.rules, { permittedMode: permittedMode });
    bodyFilterObj.reload(obj.rules, { permittedMode: permittedMode });
};

var mainFunction = function(err, firstTimeLoad) {
    if (err) {
        console.log("Fatal Error: " + err);
        Common.quit();
        return;
    }

    refresh_filter();

    if (!firstTimeLoad) // execute the following code only in the first time
        return;


    var initPortListener = function(listenAddress, callback) {
        async.waterfall(
            [
                function(callback) {
                    var urlObj = url.parse(listenAddress);
                    // logger.info("protocol: "+urlObj.protocol+", hostname:"+urlObj.hostname+", port: "+urlObj.port);
                    var isSSL = urlObj.protocol === "https:";
                    var port = urlObj.port;
                    if (!port)
                        port = (isSSL ? 443 : 80);
                    var host = urlObj.hostname;
                    callback(null, host, port, isSSL);
                },
                function(host, port, isSSL, callback) {
                    if (isSSL) {
                        readCerts(function(err, opts) {
                            if (err) {
                                callback(err);
                                return;
                            } else {
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
                        logger.info(`${(server_options ? "HTTPS" : "HTTP")}: listening at ${host}:${port}`);
                        callback(null);
                    });
                    var closeListener = function(callback) {
                        myserver.close(callback);
                    };
                    Common.exitJobs.push(closeListener);
                }
            ],
            function(err) {
                if (err) {
                    logger.error("Cannot open listener for " + listenAddress + ", err: " + err);
                }
                if (typeof callback === "function") callback(err);
            }
        );
    };
    var readCerts = function(callback) {
        if (!Common.sslCerts || !Common.sslCerts.ca || !Common.sslCerts.cert || !Common.sslCerts.key) return callback("bad parameter Common.sslCerts");
        var sslCerts = {};
        async.forEachOf(
            Common.sslCerts,
            function(item, key, callback) {
                fs.readFile(item, function(err, data) {
                    if (err) {
                        logger.error("Cannot read " + item + " file, err: " + err);
                    } else {
                        sslCerts[key] = data;
                    }
                    callback(err);
                });
            },
            function(err) {
                checkCerts(sslCerts,callback);
            }
        );
    };

    machineModule.initMachine();

    async.eachSeries(
        Common.listenAddresses,
        initPortListener,
        function(err) {
            // after finish listen - register to management
            registerPlatform();            
        }
    );
     

    process.on('SIGINT', function() {
        logger.info("Restserver caught SIGINT signal");
        exitServer();
    });
    process.on('SIGTERM', function() {
        logger.info("Restserver caught SIGTERM signal");
        exitServer();
    });

};

let registeredPlatID;
let registeredPlatIP;
let registerRefreshInterval;

async function registerPlatform(){
    if (Common.registerParams) {
        const params = Common.registerParams;
        try {            
            let platform_ip = params.platform_ip;
            if (!platform_ip) {
                platform_ip = await detectIP();
            }
            let response = await axios({
                method: "get",
                url: `${params.mgmtURL}/selfRegisterPlatform?platform_ip=${platform_ip}`,
                headers: {
                    'fe-user': params.user,
                    'fe-pass': params.password
                }       
            });
            if (response.data.status == "0" && response.data.platid) {
                registeredPlatIP = platform_ip;
                registeredPlatID = response.data.platid;                
                logger.info(`Platform registered on management (${params.mgmtURL}). platid: ${registeredPlatID}, ip: ${registeredPlatIP}`);
                startRegisterRefresh();
            } else {
                logger.info(`Unable to register on management (${params.mgmtURL}). status: ${response.data.status}, msg: ${response.data.msg}`);
                setTimeout(registerPlatform,5000);
            }
        } catch (err) {
            logger.error(`Unable to register on management (${params.mgmtURL}). err: ${err}`,err);
            setTimeout(registerPlatform,5000);
        }
    }
}


/**
 * Detect the local IP address
 * Try to send request to management and get the localAddress from the socker
 * @returns IP address
 */
async function detectIP() {
    const params = Common.registerParams;
    let response = await axios({
        method: "get",
        url: `${params.mgmtURL}/selfRegisterPlatformTtl?platform_ip=none&idx=99999`,
        headers: {
            'fe-user': params.user,
            'fe-pass': params.password
        } 
    });
    const ip = response.request.socket.localAddress;
    logger.info(`Detected local ip address: ${ip} `);
    return ip;
}

/**
 * Refresh the platform registration on the server
 * If refresh failed - re-register platform
 */
async function registerRefresh() {
    const params = Common.registerParams;
    try {
        let response = await axios({
            method: "get",
            url: `${params.mgmtURL}/selfRegisterPlatformTtl?platform_ip=${registeredPlatIP}&idx=${registeredPlatID}`,
            headers: {
                'fe-user': params.user,
                'fe-pass': params.password
            }       
        });
        if (response.data.status == "0") {
            //logger.info(`Updated...`);
        } else {
            logger.info(`Unable to refresh registration on management (${params.mgmtURL}). status: ${response.data.status}, msg: ${response.data.msg}`);
            clearInterval(registerRefreshInterval);
            registerRefreshInterval = null;
            setTimeout(registerPlatform,5000);
        }
    } catch (err) {
        logger.error(`Unable to refresh registration on management (${params.mgmtURL}). err: ${err}`,err);
        clearInterval(registerRefreshInterval);
        registerRefreshInterval = null;
        setTimeout(registerPlatform,5000);
    }
}

function startRegisterRefresh() {
    if (registerRefreshInterval) {
        clearInterval(registerRefreshInterval);
        registerRefreshInterval = null;
    }
    
    registerRefreshInterval = setInterval(registerRefresh,15000);
}



async function exitServer() {
    try {
        if (machineModule.isDockerPlatform()) {
            let machineConf = machineModule.getMachineConf();
            if (machineConf) {
                await machineModule.deinitMachine(machineConf);
            }
        }
    } catch (err) {
        logger.error(`exitServer error: ${err}`, err);
    }
    Common.quit();
}

var checkCerts = function (sslCerts,cb)  {
    let item;
    async.series([
        (cb) => {
            pem.readCertificateInfo(sslCerts.cert,(err,obj) => {
                //logger.info(`readCertificateInfo. obj: ${JSON.stringify(obj,null,2)}`);
                let now = new Date().getTime();
                let valid = (!err && now >= obj.validity.start && now <=obj.validity.end);
                logger.info(`readCertificateInfo. valid: ${valid}`);
                if (valid) {
                    cb("certificate is valid");
                } else {
                    cb();
                }
            });
        },
        (cb) => {
            logger.info("Generating new https certificate..");
            pem.createCertificate({ days: 3650, selfSigned: true }, function (err, keys) {
                //console.log(`keys: ${JSON.stringify(keys,null,2)}`);
                item = keys;
                sslCerts.key = item.clientKey;
                sslCerts.cert = item.certificate;
                cb(err);
              });
        },

        (cb) => {
            fs.writeFile(Common.sslCerts.key,item.clientKey,(err) => {
                cb(err);
            });
        },
        (cb) => {
            fs.chmod(Common.sslCerts.key, 0o600, (err) => {
                cb(err);
            });
        },
        (cb) => {
            fs.writeFile(Common.sslCerts.cert,item.certificate,(err) => {
                cb(err);
            });
        },
        (cb) => {
            fs.chmod(Common.sslCerts.cert, 0o600, (err) => {
                cb(err);
            });
        }
    ],(err) => {
        cb(null,sslCerts);
    });
}

var accesslogger = accesslog({
    path: './log/access_log.log'
});

function nocache(req, res, next) {
    if (!req.headers['range']) {
        res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        res.header('Expires', '-1');
        res.header('Pragma', 'no-cache');
    }
    next();
}

function validateToken(req, res, next) {
    let token = req.header('Jwt-Token');
    if (!token) {
        logger.error(`Rejectaccess to ${req.url} without token`);
        res.send(401);
        return;
    }
    jwt.verify(token,Common.managementPublicKey,{ algorithm: 'RS256'},function(err, decoded) {
        if (err) {
            logger.error(`Reject access to ${req.url}. Unable to verify token "${token}"`,err);
            res.send(401);
        }
        //logger.info(`Token verified! decoded: ${JSON.stringify(decoded,null,2)}`);
        next();
    });

}

function buildServerObject(server) {

    server.on('uncaughtException', function(request, response, route, error) {
        logger.error("Exception in http server: request url: " + request.url + " error: " + JSON.stringify(error && error.stack || error));
        try {
            response.send(error);
        } catch (e) {
            logger.warn("response already done");
        }
        return true;
    });

    server.use(restify.plugins.queryParser({ mapParams: true }));
    server.use(urlFilterObj.useHandler);
    server.use(restify.plugins.bodyParser({ mapParams: false }));
    server.use(bodyFilterObj.useHandler);
    server.use(validateToken);
    server.use(function(req, res, next) {
        req.realIP = req.headers['x-real-ip'] || req.connection.remoteAddress;
        next();

    });
    server.use(accesslogger);
    // server.use(restify.gzipResponse());
    server.use(nocache);
    server.get("/", function(req, res) { res.end("OK"); });
    server.get("/startPlatform", machineModule.startPlatformGet);
    server.post("/startPlatform", machineModule.startPlatformPost);
    server.post("/killPlatform", machineModule.killPlatform);
    server.get("/checkPlatform", machineModule.checkPlatform);
    server.post("/attachUser", userModule.attachUser);
    server.get("/detachUser", userModule.detachUser);
    server.get("/installApk", appModule.installApk);
    server.post("/attachApps", appModule.attachApps);
    server.get("/getPackagesList", appModule.getPackagesList);
    server.post("/refreshMedia", filesModule.refreshMedia);
    server.post("/applyFirewall", firewallModule.post);
    server.get("/createNewUserTarGz", createNewUserTarGzModule.create);
    server.post("/receiveSMS", userModule.receiveSMS);
    server.post("/declineCall", userModule.declineCall);
    // server.post("/connectToVpn",vpn.connectToVpn);

}

Common.loadCallback = mainFunction;
if (module) {
    module.exports = { mainFunction: mainFunction };
}