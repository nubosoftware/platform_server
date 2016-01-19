"use strict";

var http = require('http');
var Common = require('../common.js');
var StartSessionModule = require('../user.js');
var ThreadedLogger = require('../ThreadedLogger.js');

var testInput = {
    "platid": 10,
    "gateway": {
        "internal_ip": "192.168.122.1"
    },
    "management":{
        "url": "https://labalex.nubosoftware.com"
    },
    "nfs": {
        "nfs_ip": "192.168.122.1",
        "nfs_path": "/srv/nfs/homes/"
    }
};

var mainFunction = function(err, firstTimeLoad) {
    var logger = new ThreadedLogger();
    logger.info("Start test");


    postRequest(logger, function(err, res) {
        if(err) {
            logger.error("Fail, err: " + err);
        } else {
            logger.info("Success, res: " + res);
        }
        logger.info("Finish");
        Common.quit();
    });
};

var postRequest = function(logger, callback) {
    var postData = JSON.stringify(testInput);
    var options = {
        host: "127.0.0.1",
        port: 3333,
        path: "/startPlatform",
        method: "POST",
        rejectUnauthorized: false,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': postData.length
        },
    };
    var callbackDone = false;
    var resData = "";
    //logger.info('sendRequestCreateUserOnPlatform req: ' + postData);
    var req = http.request(options, function(res) {
        res.setEncoding('utf8');
        res.on('data', function(chunk) {
            resData = resData + chunk;
            logger.info('sendRequestCreateUserOnPlatform *********** chunk: ' + chunk);
        });
        res.on('end', function() {
            logger.info('sendRequestCreateUserOnPlatform *********** res: ' + resData);
            var resObj = JSON.parse(resData);
            if(!callbackDone) {
                callbackDone = true;
                callback(null);
            }
        });
    });

    // set timeout on the connection
    //req.on('socket', function(socket) {
    //    socket.setTimeout(60000);
    //    socket.on('timeout', function() {
    //        console.log('Timeout while request create user');
    //    });
    //});

    req.on('error', function(e) {
        logger.error('problem with request: ' + e.message);
        if(!callbackDone) {
            callbackDone = true;
            callback("Error while request create user", {addToErrorsPlatforms: true});
        }
    });

    // write data to request body
    req.write(postData);
    req.end();
};
Common.loadCallback = mainFunction;
