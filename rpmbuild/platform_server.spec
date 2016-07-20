Summary: platform service
Name: platform_server
Version: %{_version}
Release: %{_release}
Group: System Environment/Daemons
BuildArch: noarch
#BuildArch: x86_64
License: none
Requires: forever, nodejs >= 4.4.5, nubo-common

%description
Service that implement api of possible requests to nubo platform

#%prep
#%setup -q
#%patch -p1 -b .buildroot

%build
#make -C $NUBO_PROJ_PATH clean
make -C $NUBO_PROJ_PATH

%install
rm -rf $RPM_BUILD_ROOT
mkdir -p $RPM_BUILD_ROOT/opt/platform_server
mkdir -p $RPM_BUILD_ROOT/etc/rc.d/init.d
mkdir -p $RPM_BUILD_ROOT/etc/rsyslog.d

rsync -raF $NUBO_PROJ_PATH/*.js $RPM_BUILD_ROOT/opt/platform_server/
install -m 744 $NUBO_PROJ_PATH/rh-platform_server $RPM_BUILD_ROOT/etc/rc.d/init.d/platform_server
install -m 644 $NUBO_PROJ_PATH/rsyslog-platform_server.conf $RPM_BUILD_ROOT/etc/rsyslog.d/18-nubo-platform_server.conf

%post
/sbin/chkconfig --add platform_server

#Restart after every install/update
service platform_server restart > /dev/null 2>&1 ||:

%preun
if [ $1 = 0 ]; then
	#Stop service and remove from services list on full remove
	service platform_server stop >/dev/null 2>&1 ||:
	/sbin/chkconfig --del platform_server
fi

%postun
if [ "$1" -ge "1" ]; then
	#Restart service after downgrade
	service platform_server restart > /dev/null 2>&1 ||:
fi

%clean
rm -rf $RPM_BUILD_ROOT

%files
%defattr(-,root,root)

/opt/platform_server
%config(noreplace) /opt/platform_server/Settings.json

/etc/rc.d/init.d/platform_server
%config(noreplace) /etc/rsyslog.d/18-platform_server.conf

