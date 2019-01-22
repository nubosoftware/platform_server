"use strict";

var fs = require('fs');
var execFile = require('child_process').execFile;
var async = require('async');
var validate = require("validate.js");
var _ = require('underscore');
//var Common = require('./common.js');
//var logger = Common.logger;
var ThreadedLogger = require('./ThreadedLogger.js');
var mount = require('./mount.js');
var Platform = require('./platform.js');
var http = require('./http.js');
var Audio = require('./audio.js');

module.exports = {
    attachUser: attachUser,
    detachUser: detachUser,
    //for tests
    createUser: createUser,
    endSessionByUnum: endSessionByUnum
};

function attachUser(req, res) {
    var resDone = false;
    var logger = new ThreadedLogger();
    var unum = 0;
    var obj = req.body;
    logger.logTime("Start process request attachUser");

    async.waterfall(
        [
            //create workable android user
            function (callback) {
                console.log("reqestObj: ", obj);
                createUser(obj, logger, callback);
            },
            //response to request on success
            function (session, callback) {
                unum = session.params.localid;
                var resobj = {
                    status: 1,
                    localid: unum
                };
                resDone = true;
                res.end(JSON.stringify(resobj,null,2));
                callback(null, session);
            },
            //post create processes (attach applications, etc)
            function (session, callback) {
                callback(null);
            }
        ], function (err) {
            if(err) {
                if(!resDone) {
                    var resobj = {
                        status: 0,
                        error: err
                    };
                    res.end(JSON.stringify(resobj,null,2));
                }
                logger.error("request finished with error: " + err);
            }
            logger.logTime("Finish process request attachUser");
        }
    );
}

function detachUser(req, res) {
    var unum = req.params.unum;
    var logger = new ThreadedLogger();
    logger.logTime("Start process request detachUser");
    var platform = new Platform(logger);
    var resobj;
    if(isNaN(unum) || (unum <= 0)) {   // is unum does not greater that 0 mean check if unum is number too
        resobj = {status: 0, message: "invalid unum, unum is " + unum};
        res.end(JSON.stringify(resobj,null,2));
    } else {
        endSessionByUnum(unum, logger, function (err) {
            if(err) {
                resobj = {status: 0, error: err};
            } else {
                resobj = {status: 1, message: "User " + unum + " removed"};
            }
            res.end(JSON.stringify(resobj,null,2));
            logger.logTime("Finish process request detachUser");
        });
    }
}

function createUser(obj, logger, callback) {
    var timeZone = obj.timeZone;
    var localid = 0;
    var platform = new Platform(logger);
    var session = {
        login: obj.login,
        platform: platform,
        logger: logger,
        nfs: obj.nfs,
        mounts: obj.mounts
    };
    var addToErrorsPlatforms = false;
    var platformErrorFlag = false;

    /*
     * Create startup.json, Session.xml, sessionid
     */
    //function createSessionFiles(session, callback) {
    //    var login = session.login;
    //    async.series([
    //            // Handle certificate if one exists
    //            function (callback) {
    //                var domain = login.mainDomain;
    //                var email = login.userName;
    //                User.handleCertificatesForUser(domain, email, deviceID, callback);
    //            },
    //            function (callback) {
    //                //create imServerParams file
    //                User.saveIMSettingsFile(session.email, login.imUserName, deviceID, localid, function (err) {
    //                    if(err) {
    //                        logger.error("Error saveIMSettingsFile : " + err);
    //                    }
    //                    callback(null);
    //                });
    //            },
    //            function (callback) {
    //                //create Session.xml
    //                var rootFolder = Common.nfshomefolder;
    //                var xml_file = rootFolder + User.getUserDeviceDataFolder(UserName, deviceID) + "Session.xml";
    //                logger.info("rootFolder: " + rootFolder + ", xml_file: " + xml_file);
    //                var xml_file_content = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\r\n" +
    //                    "<session>\r\n" +
    //                    "\t<gateway_url>" + session.params.gatewayInternal + "</gateway_url>\r\n" +
    //                    "\t<gateway_controller_port>" + session.params.gatewayControllerPort + "</gateway_controller_port>\r\n" +
    //                    "\t<gateway_apps_port>" + session.params.gatewayAppsPort + "</gateway_apps_port>\r\n" +
    //                    "\t<platformID>" + platform.params.platid + "</platformID>\r\n" +
    //                    "\t<management_url>" + Common.serverurl + "</management_url>\r\n" +
    //                    "\t<username>" + login.loginParams.userName + "</username>\r\n" +
    //                    "</session>\r\n";
    //                createFile(xml_file, xml_file_content, '600', 1000, 1000, function (err) {
    //                    callback(err);
    //                });
    //            },
    //            function (callback) {
    //                var rootFolder = Common.nfshomefolder;
    //                var sess_file = rootFolder + User.getUserDeviceDataFolder(UserName, deviceID) + "sessionid";
    //                //logger.info("rootFolder: "+rootFolder+", sess_file: "+sess_file);
    //                var sess_file_content = session.params.sessid;
    //                createFile(sess_file, sess_file_content, '644', 1000, 1000, function (err) {
    //                    callback(err);
    //                });
    //            }
    //        ], function (err) {
    //            //logger.info("Session.xml and sessionid created succesfully");
    //            if(err) {
    //                logger.info("Error: Cannot create session description files");
    //            }
    //            callback(err);
    //        }
    //    );
    //}

    /**
     * Run am create-user on the platform
     */

    function amCreateUser(platform, session, callback) {
        platform.execFile("am", ["create-user", localid], function (err) {
            if(err) {
                var msg = "Error in adb shell: " + err;
                platformErrorFlag = true;
                callback(msg);
                return;
            }
            callback(null);
        });
    }

    /*
     * create android user, chech his number, empty directories
     * Arguments:
     *  callback(err, localid)
     *  err - error message, if exist
     *  localid - number of created user
     */
    function createUserAndroid(callback) {
        var localid;
        async.series([
                // create user
                function (callback) {
                    platform.execFile("pm", ["create-user", session.params.email + session.params.deviceid], function (err, stdout, stderr) {
                        if(err) {
                            addToErrorsPlatforms = true;
                            var msg = "Error in adb shell: " + err;
                            platformErrorFlag = true;
                            callback(msg);
                            return;
                        }
                        var re = new RegExp('Success: created user id ([0-9]+)');
                        var m = re.exec(stdout);
                        if(m) {
                            localid = m[1];
                            logger.logTime("pm create-user");
                            callback(null);
                        } else {
                            callback("Error with PM - cannot get localid");
                        }
                    });
                }, //function(callback)
                function (callback) {
                    execFile("rm", ["-rf", "/Android/data/user/" + localid], function (err) {callback(err);});
                },
                function (callback) {
                    execFile("rm", ["-rf", "/Android/data/user_de/" + localid], function (err) {callback(err);});
                },
                function (callback) {
                    fs.mkdir("/Android/data/user/" + localid, function (err) {callback(err);});
                },
                function (callback) {
                    fs.mkdir("/Android/data/user_de/" + localid, function (err) {callback(err);});
                },		
                //function (callback) {
                //    fs.chown("/Android/data/user/" + localid, 1000, 1000, function (err) {callback(err);});
                //},
                //function (callback) {
                //    fs.fchmod("/Android/data/user/" + localid, 0o771, function (err) {callback(err);});
                //},
                function (callback) {
                    fs.mkdir("/Android/data/system/users/" + localid, function (err) {callback(null);});
                },
                //function (callback) {
                //    fs.chown("/Android/data/system/users/" + localid, 1000, 1000, function (err) {callback(err);});
                //},
                //function (callback) {
                //    fs.fchmod("/Android/data/system/users/" + localid, 0o700, function (err) {callback(err);});
                //},
                function (callback) {
                    execFile("sync", [], function (err) {callback(err);});
                },
                function (callback) {
                    execFile("rm", ["-rf", "/Android/data/misc/keystore/user_" + localid + '/*'], function (err) {callback(err);});
                }
            ], function (err) {
                if(err) {
                    logger.info("Error: cannot initializate android user err:" + err);
                }
                callback(err, localid);
            }
        );
    }

// End of definitions

    /*
     * Start of code
     */
    async.series([
        function (callback) {
            session.params = {
                email: obj.session.email,
                deviceid: obj.session.deviceid
            };
            callback(null);
        },
        // create user
        function (callback) {
            createUserAndroid(function (err, res) {
                var val = validate.single(localid, {numericality: {onlyInteger: true}});
                if (val) {
                    err = "Error creating user";
                }

                if(!err) localid = res;
                callback(err);
            });
        },
        // create session files
//            function(callback) {
//                createSessionFiles(platform, session, function(err) {
//                    logger.logTime("createSessionFiles");
//                    callback(err);
//                });
//            },
        // mount all nfs folders
        function (callback) {
            session.params.localid = localid;
            mount.fullMount(session, null, function (err) {
                if(err) logger.error("Cannot mount user's directories");
                logger.logTime("fullMount");
                callback(err);
            });
        },
        function (callback) {
            Audio.initAudio(localid, function (err) {
                logger.logTime("initAudio");
                if (err) {
                    logger.info("initAudio error: "+err);
                }
            });
            // do not wait to init audio to finish before finish attach session
            callback(null);
        },
        function (callback) {
            refreshPackages(session, function (err) {
                logger.logTime("refreshPackages");
                callback(err);
            });
        },
        function (callback) {
            setPerUserEnvironments(session, timeZone, callback);
        },
        function (callback) {
            amCreateUser(platform, session, function (err) {
                logger.logTime("amCreateUser");
                callback(err);
            });
        }
    ], function (err, results) {
        if(err) {
            logger.info("Error during session create: " + err);
            endSessionByUnum(localid, logger, function (error) {
                callback(err);
            });
        } else {
            logger.info("User attached successfully");
            callback(null, session);
        }
    });
    return;
}

function setPerUserEnvironments(session, timeZone, callback) {
    var login = session.login;
    var email = login.userName;
    var localid = session.params.localid;
    var lang = login.lang;
    var countrylang = login.countrylang;
    var localevar = login.localevar;

    async.series(
        [
            function(callback) {
                session.platform.execFile("setprop", ["nubo.language.u" + localid, lang], function() {callback(null);});
            },
            function(callback) {
                session.platform.execFile("setprop", ["nubo.country.u" + localid, countrylang], function() {callback(null);});
            },
            function(callback) {
                session.platform.execFile("setprop", ["nubo.localevar.u" + localid, localevar], function() {callback(null);});
            },
            function(callback) {
                if(timeZone !== null && timeZone !== "") {
                    session.platform.execFile("setprop", ["nubo.timezone.u" + localid, timeZone], function() {callback(null);});
                } else {
                    session.logger.error("ERROR: missing timeZone param.");
                    callback(null);
                }
            },
            function(callback) {
                session.platform.execFile("getprop", [], function() {callback(null);});
            }
        ], function(err) {
        callback(null);
        }
    );
}

function refreshPackages(session, callback) {
    var localid = session.params.localid;
    var platform = session.platform;
    var deviceType = session.login.deviceType;

    async.series(
        [
            function (callback) {
                platform.execFile("pm", ["refresh", localid], function(err) {callback(null);});
            },
//            function (callback) {
//                platform.execFile("pm", ["disable", "--user", localid, "com.android.vending"], function(err) {callback(null);});
//            },
            function (callback) {
                if(deviceType === 'Web') {
                    platform.execFile("pm", ["disable", "--user", localid, "com.android.browser"], function(err) {callback(null);});
                } else {
                    callback(null);
                }
            },
            function (callback) {
                if(deviceType === 'Web') {
                    platform.execFile("pm", ["enable", "--user", localid, "com.android.inputmethod.latin"], function(err) {callback(null);});
                } else {
                    callback(null);
                }
            }
        ], function(err) {
            callback(err);
        }
    );
}

// This function should been called after session and platform locked
// session can been null, platform can been null
function endSessionByUnum(unum, logger, callback) {
    var platform = new Platform(logger);
    var sessLogger = logger;
    async.series(
        [
            function (callback) {
                if(unum === 0) {
                    callback("no UNum");
                } else {
                    async.series(
                        [
                            // Logout. pm remove-user close all user's applications
                            function (callback) {
                                platform.execFile("pm", ["remove-user", unum.toString()], function (err, stdout, stderr) {
                                    sessLogger.logTime("pm remove-user");
                                    callback(null);
                                    // Try to continue even if pm failed
                                });
                                // platform.exec
                            },
                            function (callback) {
                                Audio.deInitAudio(unum, function (err) {
                                    logger.logTime("deInitAudio");
                                    if (err) {
                                        logger.info("deInitAudio error: "+err);
                                    }
                                });
                                // do not wait to deinit audio to finish
                                callback(null);
                            },
                            // force close all user's applications if it still exist
                            function (callback) {
                                execFile("ps", ["auxn"], function (err, stdout, stderr) {
                                    if(err) {
                                        callback(err);
                                    } else {
                                        var lines = stdout.split("\n");
                                        var procs = _.map(lines, function(line) {
                                            var fields = line.split(/[ ]+/, 3);
                                            var procObj = {
                                                uid: fields[1] || "",
                                                pid: fields[2] || ""
                                            };
                                            return procObj;
                                        });
                                        var userTest = new RegExp("^" + unum.toString() + "[0-9]{5}$");
                                        var userProcs = _.filter(procs, function(procObj) {return (userTest.test(procObj.uid));});
                                        if(userProcs.length !== 0) {
                                            logger.warn("User's processes still exist after pm remove-user: " + JSON.stringify(userProcs));
                                        }
                                        callback(null);
                                    }
                                });
                                // platform.exec
                            }, // function(callback)
                            // unmount folders
                            function (callback) {
                                var session = {
                                    params: {
                                        localid: unum
                                    },
                                    platform: platform
                                };
                                mount.fullUmount(session, null, function (err) {
                                    if(err) {
                                        logger.info("ERROR: cannot umount user's directories, err:" + err);
                                        callback(err);
                                    } else {
                                        callback(null);
                                    }
                                });
                            }, // function(callback)
                            function (callback) {
                                execFile("rm", ["-rf", "/Android/data/system/users/" + unum +"/settings_system.xml"], function(err) {callback(null);});
                            },
			    function (callback) {
                                execFile("rm", ["-rf", "/Android/data/system/users/" + unum +"/settings_secure.xml"], function(err) {callback(null);});
                            },
                            function (callback) {
                                removeDirIfEmpty("/Android/data/user/" + unum, callback);
                            },
			    function (callback) {
                                removeDirIfEmpty("/Android/data/user_de/" + unum, callback);
                            },
                            function (callback) {
                                removeDirIfEmpty("/Android/data/media/" + unum, callback);
                            },
                            function (callback) {
                                removeDirIfEmpty("/Android/data/misc/keystore/user_" + unum, callback);
                            },
                            function (callback) {
                                execFile("rm", ["/Android/data/system/users/" + unum + ".xml"], function(err) {callback(null);});
                            }
                        ], function (err, results) {
                            callback(err);
                        }
                    );
                }
            }
        ], function (err, results) {
            if(err) {
                logger.error("Error during user detach: " + err);
            }
            callback(err);
        }
    );
}

function removeDirIfEmpty(dir, callback) {
    fs.readdir(dir, function(err, files) {
        if (err) {
           // some sort of error
	   callback(err);
        } else {
           if (!files.length) {
               // directory appears to be empty
               execFile("rm", ["-rf", dir], function(err) {callback(err);});
           }
        }
    });
}

//function createFile(file, data, permissions, uid, gid, callback) {
//    async.series(
//        [
//            function (callback) {
//                fs.writeFile(file, data, function (err) {
//                    callback(err);
//                });
//            },
//            function (callback) {
//                fs.chmod(file, permissions, function (err) {
//                    callback(err);
//                });
//            },
//            function (callback) {
//                fs.chown(file, uid, gid, function (err) {
//                    callback(err);
//                });
//            }
//        ], function (err) {
//            callback(err);
//        }
//    );
//}

var validateAttachUserRequestObj = function(requestObj, logger, callback) {
    var validate = require("validate.js");
    var constraints = require("nubo-validateConstraints");

    var constraint = {
        timeZone: {
            format: "[a-zA-Z0-9\\.\\_\\-\\/]+",
            length: {
                "minimum" : 1,
                "maximum" : 256
            }
        },
        login: {presence: true},
        "login.userName": constraints.requestedExcludeSpecialCharacters,
        "login.email": {presence: true, email: true},
        "login.lang": {
            format: "[a-zA-Z0-9\\.\\_\\-]+",
            length: {
                "minimum" : 1,
                "maximum" : 256
            }
        },
        "login.countrylang": {
            format: "[a-zA-Z0-9\\.\\_\\-]+",
            length: {
                "minimum" : 1,
                "maximum" : 256
            }
        },
        "login.localevar": {
            format: "[a-zA-Z0-9\\.\\_\\-]+",
            length: {
                "minimum" : 1,
                "maximum" : 256
            }
        },
        "login.deviceType": constraints.excludeSpecialCharacters,
        session: {presence: true},
        "session.email": {presence: true, email: true},
        "session.deviceid": constraints.deviceIdConstrRequested,
        nfs: {presence: true},
        "nfs.nfs_ip": constraints.ipConstrConstrRequested,
        "nfs.nfs_path": constraints.pathConstrRequested,
        "nfs.nfs_path_slow": constraints.pathConstrOptional,
        nfs_slow: {},
        "nfs_slow.nfs_ip": constraints.ipOptionalConstr,
        "nfs_slow.nfs_path": constraints.pathConstrOptional,
        "nfs_slow.nfs_path_slow": constraints.pathConstrOptional
    };
    var res = validate(requestObj, constraint);
    if(res) logger.error("input is not valid: " + JSON.stringify(res));
    callback(res, requestObj);
};

