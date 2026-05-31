"use strict";

var path = require("path");
var async = require('async');
var validate = require("validate.js");
var Platform = require('./platform.js');
var ThreadedLogger = require('./ThreadedLogger.js');
var http = require('./http.js');
var Common = require('./common.js');
var { execDockerWaitAndroid } = require('./dockerUtils.js');

module.exports = {
    refreshMedia: refreshMedia
};

function safePathJoin(path1, path2) {
    var targetPath = '.' + path.normalize('/' + path2);
    return path.resolve(path1, targetPath)
}

function refreshMedia(req, res,next) {
    var logger = new ThreadedLogger(Common.getLogger(__filename));
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

var processRefreshMedia = async function(obj, logger, callback) {
    var unum = obj.unum;
    var paths = obj.paths;
    try {
        var userModule = require('./user.js');
        let session = await userModule.loadUserSessionPromise(unum, logger);
        const containerId = session.params.containerId;
        for (const p of paths) {
            try {
                // inside the session container the Android user is always 10
                var args = ["exec", containerId, "am", "broadcast", "--user", "10", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", safePathJoin("file:/storage/emulated/legacy/" , p)];
                await execDockerWaitAndroid(args);
            } catch (err) {
                // Ignore errors
                logger.info("processRefreshMedia. ignored error for path " + p + ": " + err);
            }
        }
    } catch (err) {
        logger.error("processRefreshMedia error: " + err);
    }
    callback(null);
};

var validateRefreshMediaRequestObj = function(reqestObj, logger, callback) {
    var validate = require("validate.js");
    var constraints = require("@nubosoftware/nubo-validateconstraints")(validate);

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

