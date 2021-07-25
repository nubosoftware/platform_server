"use strict";

var fs = require('fs');
var execFile = require('child_process').execFile;
var async = require('async');
var validate = require("validate.js");
var _ = require('underscore');
var ps = require('ps-node');
var Common = require('./common.js');
//var logger = Common.logger;
var ThreadedLogger = require('./ThreadedLogger.js');
var mount = require('./mount.js');
var Platform = require('./platform.js');
var http = require('./http.js');
var Audio = require('./audio.js');
var ps = require('ps-node');

module.exports = {
    attachUser: attachUser,
    detachUser: detachUser,
    //for tests
    createUser: createUser,
    endSessionByUnum: endSessionByUnum,
    receiveSMS: receiveSMS,
    declineCall: declineCall
};

function attachUser(req, res) {
    var resDone = false;
    var logger = new ThreadedLogger(Common.getLogger(__filename));
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
    var logger = new ThreadedLogger(Common.getLogger(__filename));
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



var sessCache = {};

function saveUserSessionParams(localid,session,cb) {
    sessCache['sess_'+localid] = session;
    let fileName = "./sessions/localid_"+localid+".json";
    let sessStr = JSON.stringify(session,null,2);
    fs.writeFile(fileName,sessStr,function(err){
        cb(err);
    });
}

function loadUserSessionParams(localid,logger,cb) {
    let session = sessCache['sess_'+localid];
    if (session) {
        cb(null,session);
        return;
    }
    let fileName = "./sessions/localid_"+localid+".json";
    fs.readFile(fileName,'utf8',function(err, data){
        if (err) {
            logger.error("Error read session file: "+err);
            console.error(err);
            cb(err,null);
            return;
        }
        try {
            session = JSON.parse(data);
            cb(null,session);
        } catch(err) {
            logger.error("Error parsing session file: "+err);
            console.error(err);
            cb(err,null);
        }
    });
}

function deleteSessionParams(localid,cb) {
    sessCache['sess_'+localid] = null;
    let fileName = "./sessions/localid_"+localid+".json";
    fs.unlink(fileName,function(err){
        if (cb) {
            cb(err);
        }
    });
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
        mounts: obj.mounts,
        xml_file_content: obj.xml_file_content
    };
    var addToErrorsPlatforms = false;
    var platformErrorFlag = false;


    function debugCheckConfFile(step, cb) {
        let fileName = "/Android/data/system/users/" + localid + "/package-restrictions.xml";
        fs.readFile(fileName, 'utf8', function (err, data) {
            if (err) {
                logger.error("Error read package-restrictions.xml file: " + err);
                console.error(err);
                cb(null);
                return;
            }
            if ( data.indexOf("pkg name=\"amirz.rootless.nexuslauncher\" inst=\"false\"") >= 0 ) {
                logger.error("debugCheckConfFile. package-restrictions.xml changed! step: "+step+", file: "+data);
            } else {
                logger.info("debugCheckConfFile. package-restrictions.xml is ok. step: "+step);
            }
            cb(null);

        });

    }

    function createSessionFiles(session, callback) {
        if (!session.xml_file_content || session.xml_file_content.length == 0) {
		callback(null);
		return;
	}
        let xml_file = "/Android/data/user/" + localid+"/Session.xml"
        fs.writeFile(xml_file, session.xml_file_content, function(err) {
            if (err) {
                var msg = "Failed to create Session.xml file. error: " + err;
                logger.error(msg);
                callback(msg);
            } else {
                fs.chmod(xml_file, '600', function(err) {
                    var msg = null;
                    if (err) {
                        msg = "Failed to chmod Session.xml file. error: " + err;
                    }
                    fs.chown(xml_file, 1000, 1000, function(err) {
                        if (err) {
                            msg = msg + "Failed to chown Session.xml file. error: " + err;
                        }
                        callback(msg);
                    });
                });
            }
        });
    }

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
                deviceid: obj.session.deviceid,
                appName: obj.session.appName
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
        function (cb) {
            session.params.localid = localid;
            saveUserSessionParams(localid,session,cb);
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
            mount.fullMount(session, null, function (err) {
                if(err) logger.error("Cannot mount user's directories");
                logger.logTime("fullMount");
                callback(err);
            });
        },
        function(callback) {
            createSessionFiles(session,callback);
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
    var appName = (session.params.appName ? session.params.appName : "Nubo");

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
                session.platform.execFile("setprop", ["nubo.appname.u" + localid, appName], function() {callback(null);});
            },
            function(callback) {
                if(timeZone !== null && timeZone !== "") {
                    session.platform.execFile("setprop", ["nubo.timezone.u" + localid, timeZone], function() {callback(null);});
                } else {
                    session.logger.error("ERROR: missing timeZone param.");
                    callback(null);
                }
            }/*,
            function(callback) {
                session.platform.execFile("getprop", [], function() {callback(null);});
            }*/
        ], function(err) {
        callback(null);
        }
    );
}

function removePerUserEnvironments(localid,platform,logger,cb) {
    logger.info("removePerUserEnvironments. localid: "+localid);
    async.series(
        [
            function(callback) {
                platform.execFile("setprop", ["nubo.language.u" + localid, ""], function() {callback(null);});
            },
            function(callback) {
                platform.execFile("setprop", ["nubo.country.u" + localid, ""], function() {callback(null);});
            },
            function(callback) {
                platform.execFile("setprop", ["nubo.localevar.u" + localid, ""], function() {callback(null);});
            },
            function(callback) {
                platform.execFile("setprop", ["nubo.locale.u" + localid, ""], function() {callback(null);});
            },
            function(callback) {
                platform.execFile("setprop", ["nubo.timezone.u" + localid, ""], function() {callback(null);});
            },
            function(callback) {
                platform.execFile("setprop", ["nubo.appname.u" + localid, ""], function() {callback(null);});
            }
        ], function(err) {
            if (cb) {
                logger.info("removePerUserEnvironments. finished. localid: "+localid);
                cb(err);
            };
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
                platform.execFile("pm", ["grant", "--user", localid,"com.google.android.gms","android.permission.ACCESS_FINE_LOCATION"], function (err) { callback(null); });
            },
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
    var session;
    async.series(
        [
            function (callback) {
                if(unum === 0) {
                    callback("no UNum");
                } else {
                    async.series(
                        [
                            function(callback) {
                                loadUserSessionParams(unum,logger,function(err,sessObj){
                                    session = sessObj;
                                    if (!session) {
                                        session = { };
                                    }
                                    callback();
                                });
                            },
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
                                closeUserProcesses(unum,logger,callback);
                            }, // function(callback)
                            // unmount folders
                            function (callback) {
                                session.platform = platform;
                                mount.fullUmount(session, null, function (err) {
                                    if(err) {
                                        logger.info("ERROR: cannot umount user's directories, err:" + err);
                                        callback(err);
                                    } else {
                                        callback(null);
                                    }
                                });
                            }, // function(callback)
                            /*function (callback) {
                                execFile("rm", ["-f", "/Android/data/system/users/" + unum + "/settings_system.xml"], function (err) { callback(null); });
                            },
                            function (callback) {
                                execFile("rm", ["-f", "/Android/data/system/users/" + unum + "/settings_secure.xml"], function (err) { callback(null); });
                            },*/
                            function (callback) {
                                removeNonMountedDirs(unum,logger,callback);
                            },
                            function (callback) {
                                removeMountedDirs(unum,logger,callback);
                            },
                            /*function (callback) {
                                removeDirIfEmpty("/Android/data/user/" + unum, logger, callback);
                            },
                            function (callback) {
                                removeDirIfEmpty("/Android/data/user_de/" + unum, logger, callback);
                            },
                            function (callback) {
                                removeDirIfEmpty("/Android/data/media/" + unum, logger, callback);
                            },
                            function (callback) {
                                removeDirIfEmpty("/Android/data/misc/keystore/user_" + unum, logger, callback);
                            },
                            function (callback) {
                                execFile("rm", ["/Android/data/system/users/" + unum + ".xml"], function (err) { callback(null); });
                            },*/
                            function (callback) {
                                removePerUserEnvironments(unum, platform,logger,callback);
                            },
                            function (callback) {
                                deleteSessionParams(unum,callback);
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

function closeUserProcesses(unum,logger,callback) {
    const maxWaitTime = 30;
    const waitForIteration = 2;
    let timePassed = 0;
    let userProcs = null;
    async.doWhilst(function(callback) {
        execFile("ps", ["auxn"], function (err, stdout, stderr) {
            if(err) {
                logger.info(`ps error: ${err}`);
                callback(err);
                return;
            }
            var lines = stdout.split("\n");
            var procs = _.map(lines, function(line) {
                var fields = line.split(/[ ]+/);
                var procObj = {
                    uid: fields[1] || "",
                    pid: fields[2] || "",
                    name: fields[11] || ""
                };
                return procObj;
            });
            var userTest = new RegExp("^" + unum.toString() + "[0-9]{5}$");
            userProcs = _.filter(procs, function(procObj) {return (userTest.test(procObj.uid));});
            if (userProcs.length !== 0) {
                logger.info(`closeUserProcesses Remaining processes: ${JSON.stringify(userProcs,null,2)}`);
            } else {
                logger.info(`closeUserProcesses all user processes closed. time: ${timePassed}`);
            }
            timePassed += waitForIteration;
            if (userProcs.length !== 0 && timePassed < maxWaitTime) {
                setTimeout(function(){
                    callback(null);
                },waitForIteration * 1000);
            } else {
                callback(null);
            }
        });
    }, function() {
        return (userProcs.length !== 0 && timePassed < maxWaitTime);
    }, function(err){
        if (err) {
            logger.info("closeUserProcesses failed with error: "+err);
        } else {
            if (userProcs.length !== 0) {
                logger.info(`closeUserProcesses failed after waiting ${timePassed} seconds. Killing remaining processes...`);
                // kill processes
                async.eachSeries(userProcs,function(process,cb) {
                    ps.kill(process.pid, 'SIGKILL', function(err) {
                        if (err) {
                            logger.error("Unable to kill pid "+process.pid+", kill error: ", err);
                        } else {
                            logger.info("pid "+process.pid+" has been killed.");
                        }
                        cb();
                    });
                },function(err) {
                    logger.info("Finished processes kill for user "+unum);
                });
            } else {
                logger.info(`closeUserProcesses finished sucessfully.`);
            }
        }
        callback(null);
    });

}

function checkDir(step,dir, logger, callback) {
    execFile("ls", ["-la",dir], function (err,stdout,stderr) {
        logger.info(`${step}. ls -la ${dir}: ${stdout}`);
        callback(null);
    });
}

function removeDirIfEmptyEx(dir, logger, callback) {
    execFile("ls", ["-la",dir], function (err,stdout,stderr) {
        logger.info(`removeDirIfEmptyEx. ls -la. : ${stdout}`);
        fs.rmdir(dir, function (err) {
            if (err) {
                logger.error("rmdir error: "+err);
            } else {
                logger.info("Removed empty dir: "+dir);
            }
            callback(null);
        });
    });
}


function removeMountedDirs(UNum,logger, callback) {
    const mountedDirs = [
        "/Android/data/misc/keystore/user_" + UNum,
        "/Android/data/misc_ce/" + UNum,
        "/Android/data/misc_de/" + UNum,
        "/Android/data/system/users/" + UNum,
        "/Android/data/system_ce/" + UNum,
        "/Android/data/system_de/" + UNum,
        "/Android/data/user/" + UNum,
        "/Android/data/user_de/" + UNum,
        "/Android/data/media/" + UNum,
        "/Android/data/mnt/nfs/" + UNum
    ];
    async.eachSeries(
        mountedDirs,
        function(dir, callback) {
            removeDirIfEmpty(dir,logger,callback)
        },
        function(err) {
            callback();
        });
}

function removeDirIfEmpty(dir, logger, callback) {
    fs.rmdir(dir, function (err) {
        if (err) {
            logger.error(`removeDirIfEmpty error: ${err}, dir: ${dir}`);
        } else {
            //logger.info("Removed empty dir: "+dir);
        }
        callback(null);
    });
}

function removeNonMountedDirs(UNum,logger, callback) {
    const dirs = [
        `/Android/data/misc/profiles/cur/${UNum}`,
        `/Android/data/misc/gatekeeper/${UNum}`,
        `/Android/data/misc/user/${UNum}`,
        `/Android/data/system/users/${UNum}/settings_system.xml`,
        `/Android/data/system/users/${UNum}/settings_secure.xml`,
        `/Android/data/system/users/${UNum}.xml`
    ];
    async.eachSeries(
        dirs,
        function(dir, callback) {
            fs.rm(dir,{
                force: true,
                maxRetries: 100,
                recursive: true,
                retryDelay: 100
            },function(err) {
                if (err) {
                    logger.error(`removeNonMountedDirs error: ${err}, dir: ${dir}`);
                }
                callback();
            });
        },
        function(err) {
            callback();
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

function receiveSMS(req, res) {
    var params = req.body;
    var unum = params.localid;
    var to = params.to;
    var from = params.from;
    var text = params.text;
    var pdu = params.pdu;
    var logger = new ThreadedLogger(Common.getLogger(__filename));
    logger.logTime("Start process request receiveSMS");
    var platform = new Platform(logger);
    var resobj;
    if (!to || !from || !text) {
        resobj = {status: 0, message: "invalid parameters" };
        logger.info("invalid parameters. to: "+to+", from: "+from+", text: "+text);
        res.end(JSON.stringify(resobj,null,2));
        return;
    }

    if(isNaN(unum) || (unum <= 0)) {   // is unum does not greater that 0 mean check if unum is number too
        resobj = {status: 0, message: "invalid unum, unum is " + unum};
        res.end(JSON.stringify(resobj,null,2));
        return;
    }
    var args = ["broadcast", "--user", unum, "-a", "android.intent.action.DATA_SMS_RECEIVED",
        "--es", "nubo_sms_to",to,
        "--es", "nubo_sms_from",from,
        "--es", "nubo_sms_text",text,
        "--es", "nubo_sms_pdu",pdu ];
    logger.info("Command: am "+args);
    platform.execFile("am", args, function(err, stdout, stderr) {
        if(err) {
            resobj = {status: 0, error: err};
        } else {
            resobj = {status: 1, message: "Message send to user."};
        }
        logger.info("err: "+err+", stdout: "+stdout+", stderr: "+stderr);
        res.end(JSON.stringify(resobj,null,2));
        logger.logTime("Finish process request receiveSMS");
    });
}

function declineCall(req, res) {
    var params = req.body;
    var unum = params.localid;

    var logger = new ThreadedLogger(Common.getLogger(__filename));
    logger.logTime("Start process request declineCall");
    var platform = new Platform(logger);
    var resobj;

    if(isNaN(unum) || (unum <= 0)) {   // is unum does not greater that 0 mean check if unum is number too
        resobj = {status: 0, message: "invalid unum, unum is " + unum};
        res.end(JSON.stringify(resobj,null,2));
        return;
    }
    var args = ["broadcast", "--user", unum, "-a", "com.nubo.sip.DECLINE_INCOMING_CALL" ];
    logger.info("Command: am "+args);
    platform.execFile("am", args, function(err, stdout, stderr) {
        if(err) {
            resobj = {status: 0, error: err};
        } else {
            resobj = {status: 1, message: "Message send to user."};
        }
        logger.info("err: "+err+", stdout: "+stdout+", stderr: "+stderr);
        res.end(JSON.stringify(resobj,null,2));
        logger.logTime("Finish process request declineCall");
    });




}

