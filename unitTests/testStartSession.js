"use strict";

var http = require('http');
var Common = require('../common.js');
var StartSessionModule = require('../user.js');
var ThreadedLogger = require('../ThreadedLogger.js');

var testInput = {
  "login": {
    "ttl": 600,
    "passcode": "123457",
    "isLogin": "true",
    "encrypted": "0",
    "localevar": "",
    "passcodeActivationRequired": "false",
    "authenticationRequired": "false",
    "imUserName": "alexander@nubosoftware.com",
    "deviceType": "Web",
    "countrylang": "US",
    "loginToken": "f613f7ea6d81ec63e11d052523578c91c6d647746e27b5c3f473942eb5d350b82430097bdc2d9ca0289cab100a0fda10",
    "mainDomain": "nubosoftware.com",
    "demoActivation": "false",
    "lang": "en",
    "userName": "alexander1@nubosoftware.com",
    "activationKey": "4bbe2979f68dd5ef9a2118eb14c9add8714f8ee224cadd48e60336e648a1e17b571dc4a1f85ad334142c6c067a348127",
    "isAdmin": "1",
    "deviceName": "Web",
    "deviceID": "web_default_firefox_alexander@nubosoftware.com"
  },
  "session": {
    "sessid": "7cb73c202402b3f55c23226877489952c90cf9a468c5db9fc9aeed891195857602934c0b1008d5ccc45068ba0498f43c",
    "suspend": 0,
    "totalActiveSeconds": 0,
    "email": "alexander@nubosoftware.com",
    "deviceid": "web_default_firefox_alexander@nubosoftware.com",
    "platid": "2",
    "platformline": "",
    "platform_ip": "192.168.122.90",
    "gatewayIndex": "1",
    "gatewayInternal": "172.16.1.156",
    "gatewayExternal": "172.16.1.156",
    "isSSL": "false",
    "isGWDisabled": "false",
    "gatewayPlayerPort": "7890",
    "gatewayAppsPort": "8890",
    "gatewayControllerPort": "8891"
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
        host : "127.0.0.1",
        port: 3333,
        path : "/attachUser",
        method : "POST",
        rejectUnauthorized : false,
        headers : {
            'Content-Type' : 'application/json; charset=utf-8',
            'Content-Length': postData.length
        },
    };
    var callbackDone = false;
    var resData = "";
    //logger.info('sendRequestCreateUserOnPlatform req: ' + postData);
    var req = http.request(options, function(res) {
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            resData = resData + chunk;
        });
        res.on('end', function() {
            logger.info('sendRequestCreateUserOnPlatform *********** res: ' + resData);
            if(!callbackDone) {
                callbackDone = true;
                callback(null, resData);
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
