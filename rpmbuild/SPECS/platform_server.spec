Summary: platform service
Name: nuboplatform_server
Version: %{_version}
Release: %{_release}
Group: System Environment/Daemons
BuildArch: x86_64
License: none
Requires: node-forever, nodejs >= 4.4.5, nubo-common, wget, nfs-utils, fuse, pulseaudio, pulseaudio-utils, gstreamer1, gstreamer1-plugins-base, gstreamer1-plugins-good, gstreamer1-plugins-bad-free, gstreamer1-plugins-ugly-free 

%description
Service that implement api of possible requests to nubo platform

#%prep
#%setup -q
#%patch -p1 -b .buildroot

%build

%install
rm -rf $RPM_BUILD_ROOT
mkdir -p $RPM_BUILD_ROOT/opt/platform_server
mkdir -p $RPM_BUILD_ROOT/etc/rc.d/init.d
mkdir -p $RPM_BUILD_ROOT/etc/rsyslog.d

#Copy js files from git project
FILES=`git ls-tree --full-tree -r HEAD | awk '$4 ~ /.+\.js$/ {print $4}'`
for file in ${FILES}; do
    install -D -m 644 $PROJ_PATH/$file $RPM_BUILD_ROOT/opt/platform_server/$file
done
install -m 644 $PROJ_PATH/Settings.json.init $RPM_BUILD_ROOT/opt/platform_server/Settings.json
install -m 755 $NUBO_PROJ_PATH/scripts/rootfs/etc/init.d/platform_server-rh $RPM_BUILD_ROOT/etc/rc.d/init.d/platform_server
install -m 644 $PROJ_PATH/rsyslog-platform_server.conf $RPM_BUILD_ROOT/etc/rsyslog.d/18-nubo-platform_server.conf
install -m 644 $PROJ_PATH/package.json $RPM_BUILD_ROOT/opt/platform_server/package.json
install -m 755 $PROJ_PATH/init-files.sh $RPM_BUILD_ROOT/opt/platform_server/init-files.sh
install -m 755 $PROJ_PATH/pulseaudio-user $RPM_BUILD_ROOT/opt/platform_server/pulseaudio-user

cd $RPM_BUILD_ROOT/opt/platform_server
npm install
rm package.json
find $RPM_BUILD_ROOT/opt/platform_server/node_modules -type f -exec sed "s?$RPM_BUILD_ROOT?/?g" -i {} \;
cd -

%post
/sbin/chkconfig --add platform_server
mkdir /opt/platform_server/sessions ||:

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
%config(noreplace) /etc/rsyslog.d/18-nubo-platform_server.conf

