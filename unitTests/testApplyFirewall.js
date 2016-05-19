"use strict";

var http = require('http');
var async = require('async');
var Common = require('../common.js');
var ThreadedLogger = require('../ThreadedLogger.js');

/*var testInput = {
    "tasks": [
        {"v":"v4","cmd":"flush","chain":"10_INPUT"},
        {"v":"v4","cmd":"delete-chain","chain":"10_INPUT"},
        {"v":"v4","cmd":"flush","chain":"10_OUTPUT"},
        {"v":"v4","cmd":"delete-chain","chain":"10_OUTPUT"},
        {"v":"v6","cmd":"flush","chain":"10_INPUT"},
        {"v":"v6","cmd":"delete-chain","chain":"10_INPUT"},
        {"v":"v6","cmd":"flush","chain":"10_OUTPUT"},
        {"v":"v6","cmd":"delete-chain","chain":"10_OUTPUT"},
        {"v":"v4","cmd":"delete","chain":"INPUT","job":"10_INPUT"},
        {"v":"v4","cmd":"delete","chain":"OUTPUT","job":"10_OUTPUT"},
        {"v":"v6","cmd":"delete","chain":"INPUT","job":"10_INPUT"},
        {"v":"v6","cmd":"delete","chain":"OUTPUT","job":"10_OUTPUT"},
        {"v":"v4","cmd":"new","chain":"10_INPUT"},
        {"v":"v4","cmd":"new","chain":"10_OUTPUT"},
        {"v":"v6","cmd":"new","chain":"10_INPUT"},
        {"v":"v6","cmd":"new","chain":"10_OUTPUT"},
        {"v":"v4","cmd":"append","chain":"INPUT","job":"10_OUTPUT"},
        {"v":"v4","cmd":"append","chain":"OUTPUT","job":"10_OUTPUT"},
        {"v":"v6","cmd":"append","chain":"INPUT","job":"10_OUTPUT"},
        {"v":"v6","cmd":"append","chain":"OUTPUT","job":"10_OUTPUT"}
    ]
};*/
var testInputs = [
    {
        "tasks": [
            {"v":"v4","cmd":"flush","chain":"10_INPUT"},
            {"v":"v4","cmd":"delete-chain","chain":"10_INPUT"}
        ]
    },
    {
        "tasks": [
            {"v":"v4","cmd":"flush","chain":"10_OUTPUT"},
            {"v":"v4","cmd":"delete-chain","chain":"10_OUTPUT"}
        ]
    },
    {
        "tasks": [
            {"v":"v4","cmd":"delete","chain":"INPUT","job":"10_INPUT"},
            {"v":"v4","cmd":"delete","chain":"OUTPUT","job":"10_OUTPUT"},
        ]
    },
    {
        "tasks": [
            {"v":"v4","cmd":"new","chain":"10_INPUT"},
            {"v":"v4","cmd":"new","chain":"10_OUTPUT"},
            {"v":"v6","cmd":"new","chain":"10_INPUT"},
            {"v":"v6","cmd":"new","chain":"10_OUTPUT"},
            {"v":"v4","cmd":"append","chain":"INPUT","job":"10_OUTPUT"},
            {"v":"v4","cmd":"append","chain":"OUTPUT","job":"10_OUTPUT"},
            {"v":"v6","cmd":"append","chain":"INPUT","job":"10_OUTPUT"},
            {"v":"v6","cmd":"append","chain":"OUTPUT","job":"10_OUTPUT"}
        ]
    }
]

var mainFunction = function(err, firstTimeLoad) {
    var logger = new ThreadedLogger();
    logger.info("Start test");

    async.eachSeries(
        testInputs,
        function(testInput, callback) {
            postRequest(logger, testInput, function(err, res) {
                if(err) {
                    logger.error("Fail, err: " + err);
                } else {
                    logger.info("Success, res: " + res);
                }
                callback(null);
            });
        },
        function(err) {
            logger.info("Finish");
            Common.quit();
        }
    )
};

var postRequest = function(logger, testInput, callback) {
    var postData = JSON.stringify(testInput);
    var options = {
        host : "127.0.0.1",
        port: 3333,
        path : "/applyFirewall",
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

