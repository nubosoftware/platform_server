"use strict";

var fs = require("fs");
var execFile = require('child_process').execFile;
var async = require("async");
var ThreadedLogger = require('./ThreadedLogger.js');
var Platform = require('./platform.js');

var NEW_USER_TAR = 'new_user.tar.gz';

function create(req, res) {
    var logger = new ThreadedLogger();
    var platform = new Platform(logger);
    var localid;

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
            fs.mkdir("/Android/data/user/" + localid + "/system", callback);
        },
        function(callback) {
            fs.chown("/Android/data/user/" + localid + '/system', 1000, 1000, callback);
        },
        function (callback) {
            fs.chmod("/Android/data/user/" + localid + '/system', 0o700, callback);
        },
        function(callback) {
            fs.mkdir("/Android/data/user/" + localid + "/system/media", callback);
        },
        function (callback) {
            fs.chown("/Android/data/user/" + localid + '/system/media', 1023, 1023, callback);
        },
        function (callback) {
            fs.chmod("/Android/data/user/" + localid + '/system/media', 0o770, callback);
        },
        function (callback) {
            execFile("tar", ["-czf", "/Android/data/tmp/new_user.tar.gz", "./"], {cwd: "/Android/data/user/" + localid}, callback);
        },
        function (callback) {
            execFile("cp", ["/Android/data/system/packages.list", "/Android/data/tmp/"], callback);
        },
        function(callback) {
            platform.execFile("pm", ["remove-user", localid], callback);
        },
        function (callback) {
            execFile("rm", ["-rf", "/Android/data/user/" + localid], callback);
        },
        function (callback) {
            execFile("rm", ["-rf", "/Android/data/system/users/" + localid], callback);
        },
        function (callback) {
            execFile("rm", ["-rf", "/Android/data/system/users/" + localid + ".xml"], callback);
        },
    ], function(err) {
        if (err) {
            var resobj = {
                status: 0,
                error: err
            };
            res.send(resobj);
            return;
        }

        var resobj = {
            status: 1,
            error: "created successfully"
        };
        res.send(resobj);
    });
}

module.exports = {
    create: create
}