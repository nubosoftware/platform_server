"use strict";
var constraints = require("nubo-validateConstraints")(false);

var filter = {
    "permittedMode": true,
    "rules": [{
        "path": "/",
        "constraints": {}
    }, {
        "path": "/startPlatform",
        "constraints": {},
        "bodyConstraints": {
            "platid": constraints.platIdConstrRequested,
            "platUID": constraints.requestedPlatformUIDConstr,
            "gateway": {
                "presence": true
            },
            "gateway.apps_port": constraints.portNumberConstrRequested,
            "gateway.external_ip": constraints.ExcludeSpecialCharactersRequested, // not in use
            "gateway.player_port": constraints.ExcludeSpecialCharactersRequested, // not in use
            "gateway.ssl": constraints.ExcludeSpecialCharactersRequested, // not in use
            "gateway.index": constraints.ExcludeSpecialCharactersRequested, // not in use
            "gateway.internal_ip": constraints.hostConstrRequested,
            "gateway.isGWDisabled": constraints.ExcludeSpecialCharactersRequested, // not in use
            "gateway.controller_port": constraints.portNumberConstrRequested,
            "management": {
                "presence": true
            },
            "management.url": constraints.urlConstrRequested,
            "management.ip": constraints.ipConstrOptional,
            "nfs": {
                "presence": true
            },
            "nfs.nfs_ip": constraints.hostConstrRequested,
            "nfs.ssh_ip": constraints.ExcludeSpecialCharactersRequested, // not in use
            "nfs.ssh_user": constraints.ExcludeSpecialCharactersRequested, // not in use
            "nfs.key_path": constraints.pathConstrRequested, // not in use
            "nfs.nfs_path": constraints.pathConstrRequested,
            "downloadFilesList": {
                array: constraints.pathConstrRequested
            },
            "settings": {
                "presence": true
            },
            "settings.withService": constraints.boolConstrOptional,
            "settings.hideControlPanel": constraints.boolConstrOptional,
            "rsyslog": {},
            "rsyslog.ip": constraints.ipConstrOptional,
            "rsyslog.port": constraints.portOptionalConstr
        }
    }, {
        "path": "/killPlatform",
        "constraints": {}
    }, {
        "path": "/attachUser",
        "constraints": {},
        "bodyConstraints": {
            "timeZone": {
                "format": "^[a-zA-Z0-9_\\-\/]+$",
                "length": {
                    "minimum": 1,
                    "maximum": 256
                }
            },
            "login": {
                presence: true
            },
            "login.userName": constraints.userNameConstrRequested,
            "login.email": constraints.emailConstrRequested,
            "login.lang": {
                "format": "^[.a-zA-Z0-9_\\-]+$",
                "length": {
                    "minimum": 1,
                    "maximum": 256
                }
            },
            "login.countrylang": {
                "format": "^[.a-zA-Z0-9_\\-]+$",
                "length": {
                    "minimum": 1,
                    "maximum": 256
                }
            },
            "login.localevar": {
                "format": "^[.a-zA-Z0-9_\\-]+$",
                "length": {
                    "minimum": 1,
                    "maximum": 256
                }
            },
            "login.deviceType": constraints.ExcludeSpecialCharactersOptional,
            "session": {
                presence: true
            },
            "session.email": constraints.emailConstrRequested,
            "session.deviceid": constraints.ExcludeSpecialCharactersRequested,
            "nfs": {
                presence: true
            },
            "nfs.nfs_ip": constraints.ipConstrConstrRequested,
            "nfs.nfs_path": constraints.pathConstrRequested,
            "nfs.nfs_path_slow": constraints.pathConstrOptional,
            "nfs_slow": {},
            "nfs_slow.nfs_ip": constraints.ipOptionalConstr,
            "nfs_slow.nfs_path": constraints.pathConstrOptional,
            "nfs_slow.nfs_path_slow": constraints.pathConstrOptional
        }
    }, {
        "path": "/createNewUserTarGz",
        "constraints": {}
    }, {
        "path": "/detachUser",
        "constraints": {
            "unum": constraints.NaturalNumberConstrRequested
        }
    }, {
        "path": "/installApk",
        "constraints": {
            "apk": constraints.pathConstrRequested
        }
    }, {
        "path": "/attachApps",
        "constraints": {},
        "bodyConstraints": {
            "tasks": {
                "isArray": true,
                "array": {
                    "packageName": constraints.packageNameConstrRequested,
                    "unum": constraints.NaturalNumberConstrRequested,
                    "task": constraints.binaryBoolConstrRequested
                }
            }
        }
    }, {
        "path": "/getPackagesList",
        "constraints": {
            "filter": constraints.packageNameConstrOptional
        }
    }, {
        "path": "/refreshMedia",
        "constraints": {},
        "bodyConstraints": {
            "unum": constraints.NaturalNumberConstrRequested,
            "paths": {
                "isArray": true,
                "array": constraints.pathConstrRequested
            }
        }
    }, {
        "path": "/applyFirewall",
        "constraints": {},
        "bodyConstraints": {
            "tasks": {
                "isArray": true,
                "array": {
                    "v": {
                        "presence": true,
                        "inclusion": {
                            "within": ["v4", "v6"]
                        }
                    },
                    "cmd": {
                        "presence": true,
                        "inclusion": {
                            "within": [
                                "append", "check", "delete", "insert",
                                "replace", "list", "list-rules", "flush",
                                "zero", "new", "delete-chain", "policy",
                                "rename-chain"
                            ]
                        }
                    },
                    "chain": {
                        "presence": true,
                        "format": "^[A-Z0-9_]+$",
                        "length": {
                            "minimum": 1,
                            "maximum": 1000
                        }
                    },
                    "protocol": {
                        "inclusion": {
                            "within": ["TCP", "UDP"]
                        }
                    },
                    "source": {},
                    "source.ip": constraints.ipOptionalConstr,
                    "source.port": constraints.portOptionalConstr,
                    "destination": {},
                    "destination.ip": constraints.ipOptionalConstr,
                    "destination.port": constraints.portOptionalConstr,
                    "match": {
                        "format": "^[.\ A-Za-z0-9,_\\-]+$",
                        "length": {
                            "minimum": 1,
                            "maximum": 1000
                        }
                    },
                    "job": {
                        "format": "^[.A-Z0-9_]+$",
                        "length": {
                            "minimum": 1,
                            "maximum": 1000
                        }
                    }
                }
            }
        }
    }]
};

module.exports = filter;
