"use strict";
let validate = require('validate.js');
var constraints = require("@nubosoftware/nubo-validateconstraints")(validate);

var filter = {
    "rules": [{
        "path": "/",
        "constraints": {}
    }, {
        "path": "/startPlatform",
        "constraints": {},
        "bodyConstraints": {
            "platType": {
                "inclusion": ["linux", "docker"]
            },
            "registryURL": {
                "format": "^[.a-zA-Z0-9_\\-\:\/]+$|^$",
                "length": {
                    "minimum": 0,
                    "maximum": 255
                }
            },
            "registryUser": {},
            "registryPassword": {},
            "platid": constraints.platIdConstrRequested,
            "platUID": constraints.requestedPlatformUIDConstr,
            "gateway": {
                "presence": true
            },
            "gateway.apps_port": constraints.portNumberConstrRequested,
            "gateway.external_ip": {}, // not in use
            "gateway.player_port": {}, // not in use
            "gateway.ssl": {}, // not in use
            "gateway.index": {}, // not in use
            "gateway.internal_ip": constraints.hostConstrRequested,
            "gateway.isGWDisabled": {}, // not in use
            "gateway.controller_port": constraints.portNumberConstrRequested,
            "management": {
                "presence": true
            },
            "management.url": {},
            "management.ip": {},
            "nfs": {
                "presence": true
            },
            "nfs.nfs_ip": constraints.hostConstrRequested,
            "nfs.ssh_ip": {}, // not in use
            "nfs.ssh_user": {}, // not in use
            "nfs.key_path": {}, // not in use
            "nfs.nfs_path": constraints.pathConstrRequested,
            "downloadFilesList": {
                array: constraints.pathConstrRequested
            },
            "proxy": {},
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
        "constraints": {},
        "bodyConstraints": {
            "platid": constraints.platIdConstrOptional,
            "platUID": constraints.PlatformUIDConstrOptional,
        }
    }, {
        "path": "/checkPlatform",
        "constraints": {}
    }, {
        "path": "/attachUser",
        "constraints": {},
        "bodyConstraints": {
            "timeZone": {
                "format": "^[a-zA-Z0-9_\\-\/]+$|^$",
                "length": {
                    "minimum": 0,
                    "maximum": 256
                }
            },
            "login": {
                presence: true
            },
            "login.userName": constraints.userNameConstrRequested,
            "login.email": {}, // not in use
            "login.lang": {
                "format": "^[.a-zA-Z0-9_\\-]+$|^$",
                "length": {
                    "minimum": 0,
                    "maximum": 256
                }
            },
            "login.countrylang": {
                "format": "^[.a-zA-Z0-9_\\-]+$|^$",
                "length": {
                    "minimum": 0,
                    "maximum": 256
                }
            },
            "login.localevar": { },
            "login.deviceType": constraints.ExcludeSpecialCharactersOptional,
            "session": {
                presence: true
            },
            "session.email": constraints.emailConstrRequested,
            "session.deviceid": constraints.ExcludeSpecialCharactersRequested,
            "session.appName": {},
            "session.docker_image": {},
            "session.recording": {},
            "session.recording_path": {},
            "nfs": {
                presence: true
            },
            "nfs.nfs_ip": constraints.ipConstrConstrRequested,
            "nfs.nfs_path": constraints.pathConstrRequested,
            "nfs.nfs_path_slow": constraints.pathConstrOptional,
            "nfs_slow": {},
            "nfs_slow.nfs_ip": constraints.ipOptionalConstr,
            "nfs_slow.nfs_path": constraints.pathConstrOptional,
            "nfs_slow.nfs_path_slow": constraints.pathConstrOptional,
            "mounts" : {},
            "xml_file_content": {},
            "firewall": {},
            "platformSettings": {},
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
                    "packageName": constraints.pathConstrRequested,
                    "unum": constraints.NaturalNumberConstrRequested,
                    "task": {
                        "inclusion": {
                            "within": ["0", "1", "2" ,0, 1, 2]
                        }
                    },
                    "filename": constraints.pathConstrOptional
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
        "path": "/receiveSMS",
        "constraints": {},
        "bodyConstraints": {
            "to": {},
            "from": {},
            "text": {},
            "localid": constraints.NaturalNumberConstrRequested,
            "pdu": {}
        }
    }, {
        "path": "/declineCall",
        "constraints": {},
        "bodyConstraints": {
            "localid": constraints.NaturalNumberConstrRequested
        }
    },{
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
                        "format": "^[A-Z0-9_]+$|^$",
                        "length": {
                            "minimum": 0,
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
                        "format": "^[.\ A-Za-z0-9,_\\-]+$|^$",
                        "length": {
                            "minimum": 0,
                            "maximum": 1000
                        }
                    },
                    "job": {
                        "format": "^[.A-Z0-9_]+$|^$",
                        "length": {
                            "minimum": 0,
                            "maximum": 1000
                        }
                    }
                }
            }
        }
    }]
};

module.exports = filter;
