"use strict";
var constraints = require("nubo-validateConstraints");

var filter = {
    "permittedMode": true,
    "rules": [{
        "path": "/",
        "constraints": {}
    }, {
        "path": "/startPlatform",
        "constraints": {},
        "bodyConstraints":{
            "platid": constraints.platIdConstrRequested,
            "platUID": constraints.requestedPlatformUIDConstr,
            "gateway": {
                "presence": true
            },
            "gateway.apps_port": constraints.portNumberConstrRequested,
            "gateway.external_ip": {}, //not in use
            "gateway.player_port": {}, //not in use
            "gateway.ssl": {}, //not in use
            "gateway.index": {}, //not in use
            "gateway.internal_ip": constraints.ipConstrOptional,
            "gateway.isGWDisabled": {}, //not in use
            "gateway.controller_port": constraints.portNumberConstrRequested,
            "management": {
                "presence": true
            },
            "management.url": constraints.hostConstr,
            "management.ip": constraints.ipConstrRequested,
            "nfs": {
                "presence": true
            },
            "nfs.nfs_ip": constraints.ipConstrRequested,
            "nfs.ssh_ip": {}, //not in use
            "nfs.ssh_user": {}, //not in use
            "nfs.key_path": {}, //not in use
            "nfs.nfs_path": constraints.pathConstrRequested,
            "downloadFilesList": {
                array : constraints.pathConstrRequested
            },
            "settings": {
                "presence": true
            },
            "settings.withService": constraints.boolConstrOptional,
            "settings.hideControlPanel": constraints.boolConstrOptional,
            "rsyslog": {},
            "rsyslog.ip": constraints.ipConstrOptional,
            "rsyslog.port": constraints.ipConstrOptional
        }
    }, {
        "path": "/killPlatform",
        "constraints": {}
    }, {
        "path": "/attachUser",
        "constraints": {},
        "bodyConstraints": {
            "timeZone": {
                "format": "^([a-zA-Z0-9\\_\\-\\/]+\.?)+$",
                "length": {
                    "minimum": 1,
                    "maximum": 256
                }
            },
            "login": {
                presence: true
            },
            "login.userName": constraints.requestedExcludeSpecialCharacters,
            "login.email": constraints.emailConstrRequested,
            "login.lang": {
                "format": "^([a-zA-Z0-9\\_\\-]+\.?)+$",
                "length": {
                    "minimum": 1,
                    "maximum": 256
                }
            },
            "login.countrylang": {
                "format": "^([a-zA-Z0-9\\_\\-]+\.?)+$",
                "length": {
                    "minimum": 1,
                    "maximum": 256
                }
            },
            "login.localevar": {
                "format": "^([a-zA-Z0-9\\_\\-]+\.?)+$",
                "length": {
                    "minimum": 1,
                    "maximum": 256
                }
            },
            "login.deviceType": constraints.excludeSpecialCharacters,
            "session": {
                presence: true
            },
            "session.email": constraints.emailConstrRequested,
            "session.deviceid": constraints.requestedExcludeSpecialCharacters,
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
            "apk": {
                "presence": true,
                "length": {
                    "minimum": 4
                },
                "format": {
                    "pattern": "^([A-Za-z0-9\\-_\/]+\.?)+\.apk$"
                }
            }
        }
    }, {
        "path": "/attachApps",
        "constraints": {},
        "bodyConstraints": {
            "tasks": {
                "isArray": true,
                "array": {
                    "packageName": constraints.packageNameConstrRequested,
                    "unum": constraints.IndexConstrRequested,
                    "task": {
                        "presence": true,
                        "inclusion": {
                            "within": [0, 1]
                        }
                    }
                }
            }
        }
    }, {
        "path": "/getPackagesList",
        "constraints": {
            "filter": {
                "format": {
                    "pattern": "^([A-Za-z0-9\\-_\\*]+\.?)+$"
                }
            }
        }
    }, {
        "path": "/refreshMedia",
        "constraints": {},
        "bodyConstraints": {
            "unum": constraints.IndexConstrRequested,
            "paths": {
                "isArray": true,
                "array": constraints.pathConstrRequested
            }
        }
    }, {
        "path": "/checkPlatformStatus",
        "constraints": {
            "username": {
                "presence": true,
                "format": {
                    "pattern": "^([A-Za-z0-9\\-_@]+\.?)+$"
                }
            },
            "deviceid": constraints.deviceIdConstrRequested,
            "platformip": constraints.ipConstrRequested
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
                        "format": "^[A-Z0-9\_]+$",
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
                        "format": "^([\ A-Za-z0-9\,\_\-]+\.?)+$",
                        "length": {
                            "minimum": 1,
                            "maximum": 1000
                        }
                    },
                    "job": {
                        "format": "^([A-Z0-9\_]+\.?)+$",
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