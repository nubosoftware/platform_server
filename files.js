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
    async.waterfall(
        [
            //get data from post request
            function(callback) {
                http.getObjFromRequest(req, function(err, obj) {
                    callback(err, obj);
                });
            },
            function (reqestObj, callback) {
                validateRefreshMediaRequestObj(reqestObj, logger, callback);
            },
            function(reqestObj, callback) {
                processRefreshMedia(reqestObj, logger, callback);
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
            var broadcastParams = ' -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:/storage/emulated/legacy/'+
                                    paths;
            var action = 'android.intent.action.MEDIA_SCANNER_SCAN_FILE';
            var dir = 'file:/storage/emulated/legacy/' + path;
            var cmd = 'am broadcast --user ' + unum + ' -a ' + action + ' -d ' + dir;
            platform.exec(cmd, function(err, code, signal, sshout) {
                // Ignore errors
                callback(null);
            });
        },
        function(err) {
            callback(null);
        }
    );
};

var validateRefreshMediaRequestObj = function(RequestObj, logger, callback) {
    var validate = require("validate.js");
    var constraints = require("nubo-validateConstraints");

    var constraint = {
        unum: constraints.requestedIndexConstr,
        paths: {
            isArray: true,
            array : constraints.pathConstrRequested
        }
    };
    var res = validate(reqestObj, constraint);
    if(res) logger.error("input is not valid: " + JSON.stringify(res));
    callback(res, RequestObj);
};

