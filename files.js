"use strict";

var async = require('async');
var validate = require("validate.js");
var Platform = require('./platform.js');
var ThreadedLogger = require('./ThreadedLogger.js');
var http = require('./http.js');

module.exports = {
    refreshMedia: refreshMedia
};

function refreshMedia(req, res) {
    var logger = new ThreadedLogger();
    logger.logTime("Start process request refreshMedia");
    var platform = new Platform(logger);
    var obj = req.body;
    async.waterfall(
        [
            function(callback) {
                processRefreshMedia(obj, logger, callback);
            },
            function(callback) {
                var resobj = {
                    status: 1
                };
                res.end(JSON.stringify(resobj, null, 2));
                callback(null);
            }
        ], function(err) {
            logger.logTime("Finish process request refreshMedia");
        }
    );
}

var processRefreshMedia = function(obj, logger, callback) {
    var unum = obj.unum;
    var paths = obj.paths;
    var platform = new Platform(logger);
    async.eachSeries(
        paths,
        function(path, callback) {
            var args = ["broadcast", "--user", unum, "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", "file:/storage/emulated/legacy/" + path];
            platform.execFile("am", args, function(err, stdout, stderr) {
                // Ignore errors
                callback(null);
            });
        },
        function(err) {
            callback(null);
        }
    );
};

var validateRefreshMediaRequestObj = function(reqestObj, logger, callback) {
    var validate = require("validate.js");
    var constraints = require("nubo-validateConstraints");

    var constraint = {
        unum: constraints.IndexConstrRequested,
        paths: {
            isArray: true,
            array : constraints.pathConstrRequested
        }
    };
    var res = validate(reqestObj, constraint);
    if(res) logger.error("input is not valid: " + JSON.stringify(res));
    callback(res, reqestObj);
};

