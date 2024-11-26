"use strict";

var fs = require("fs");
var execFile = require('child_process').execFile;
var async = require("async");
var ThreadedLogger = require('./ThreadedLogger.js');
var Platform = require('./platform.js');
var Common = require('./common.js');

var userDataDirs = [
    "/misc/profiles/cur/", "/misc_ce/", "/misc_de/",
    "/system/users/", "/system_ce/", "/system_de/",
    "/user/", "/user_de/"
]

function create(req, res,next) {
    var logger = new ThreadedLogger(Common.getLogger(__filename));
    var platform = new Platform(logger);
    var localid;
    var dest = "/Android/data/createDirUser/";
    var rsynUserDataDirs = function(unum, dest, callback) {
        async.each(
            userDataDirs,
            function(path, callback) {
                execFile("rsync", ["-ra", "/Android/data" + path + unum + "/", dest + path], callback);
            },
            function(err) {
                callback(err);
            }
        );
    };
    var removeUserDataDirs = function(unum, callback) {
        async.each(
            userDataDirs,
            function(path, callback) {
                execFile("rm", ["-rf", "/Android/data" + path + unum], callback);
            },
            function(err) {
                execFile("rm", ["-rf", "/Android/data/media/" + unum], function(err1) {
                    callback(err);
                });
            }
        );
    };
    logger.info("start process request createNewUserTarGz");

    async.series([
        // Separate into 2 commands because the tar happens sometimes before directories are created
        // First ssh command
        function(callback) {
            platform.execFile("pm", ["create-user", "createDirUser"], function(err, stdout, stderr) {
                if (err) {
                    var msg = 'ERROR:: cannot connect to platform ' + err;
                    callback(msg);
                    return;
                } else {
                    var re = new RegExp('Success: created user id ([0-9]+)');
                    var m = re.exec(stdout);
                    if (m) {
                        localid = m[1];
                        logger.info('Tempate user number ' + localid);
                        callback(null);
                    } else {
                        callback("Error with PM - cannot get localid");
                    }
                }

            });
        },
        function(callback) {
            fs.mkdir(dest, callback);
        },
        function(callback) {
            fs.mkdir(dest + "misc/", callback);
        },
        function(callback) {
            fs.mkdir(dest + "misc/profiles", callback);
        },
        function(callback) {
            fs.mkdir(dest + "system", callback);
        },
        function(callback) {
            rsynUserDataDirs(localid, dest, callback);
        },
        function (callback) {
            execFile("tar", ["-czf", "/Android/data/tmp/new_user7.tar.gz", "./"], {cwd: dest}, callback);
        },
        function (callback) {
            execFile("cp", ["/Android/data/system/packages.list", "/Android/data/tmp/"], callback);
        },
        function(callback) {
            platform.execFile("pm", ["remove-user", localid], callback);
        },
        function (callback) {
            execFile("rm", ["-rf", dest], callback);
        },
        function(callback) {
            removeUserDataDirs(localid, callback);
        }
    ], function(err) {
        var resobj;
        logger.info("finish process request createNewUserTarGz");
        if (err) {
            resobj = {
                status: 0,
                error: err
            };
        } else {
            resobj = {
                status: 1,
                error: "created successfully"
            };
        }
        res.send(resobj);
    });
}

module.exports = {
    create: create
}
