"use strict";

var accesslog = require('accesslog');
var url = require("url");
var restify = require("restify");
var fs = require("fs");
var Common = require('./common.js');
var logger = Common.logger;
var ThreadedLogger = require('./ThreadedLogger.js');

var machineModule = require('./machine.js');
var userModule = require('./user.js');
var appModule = require('./app.js');
var filesModule = require('./files.js');
var firewallModule = require('./firewall.js');


var mainFunction = function(err, firstTimeLoad) {
    if(err) {
        console.log("Fatal Error: " + err);
        Common.quit();
        return;
    }

    if(!firstTimeLoad)// execute the following code only in the first time
        return;

    var listenFunc = function(server, port, host) {
        server.listen(port, host, function() {
            logger.info('%s listening at %s', server.name, server.url);
        });
    };

    var initPortListener = function(port, host) {
        var myserver = restify.createServer(server_options);
        buildServerObject(myserver);
        myserver.listen(port, host, function() {
            logger.info('%s listening at %s', myserver.name, myserver.url);
        });
        var closeListener = function(callback) {
            myserver.close(callback);
        };
        Common.exitJobs.push(closeListener);
    };

    for(var i = 0; i < Common.listenAddresses.length; i++) {
        // logger.info("address: "+Common.listenAddresses[i]);
        var urlObj = url.parse(Common.listenAddresses[i]);
        // logger.info("protocol: "+urlObj.protocol+", hostname:"+urlObj.hostname+", port: "+urlObj.port);
        var isSSL = urlObj.protocol === "https:";
        var port = urlObj.port;
        if(!port)
            port = ( isSSL ? 443 : 80);
        var host = urlObj.hostname;

        var server_options;
        if(isSSL) {
            server_options = {
                key: fs.readFileSync('../cert/server.key'),
                certificate: fs.readFileSync('../cert/server.cert'),
                ca: fs.readFileSync('../cert/server.ca')
            };
        } else {
            server_options = null;
        }

        initPortListener(port, host);
    }

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

function buildServerObject(server) {

    server.on('uncaughtException', function(request, response, route, error) {
        logger.error("Exception in http server: " + (error && error.stack || error));
        response.send(error);
        return true;
    });
    server.use(restify.queryParser());
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
}

Common.loadCallback = mainFunction;
if(module) {
    module.exports = {mainFunction: mainFunction};
}
