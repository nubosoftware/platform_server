
mkfile_path := $(word $(words $(MAKEFILE_LIST)),$(MAKEFILE_LIST))
nubo_proj_dir:=$(shell cd $(shell dirname $(mkfile_path))/..; pwd)
LINUX_IMG_FULL_PATH:=$(nubo_proj_dir)/nuboplatform/out/target/product/x86_platform/linux.img
LINUX_IMG_FULL_PATH:=/opt/Android-Nougat/linux.img

current_dir := $(shell pwd)

BASE_TAG := aosp/nubo-4.4.2_r2
BASE_VERSION := 1.7

define get_project_version
$(eval $1_version=$(BASE_VERSION))
$(eval $1_buildid=$(shell git log $(BASE_TAG)..HEAD --oneline | wc -l))
$(eval $1_buildid=$(shell echo $($1_buildid)+1 | bc))
endef

$(eval $(call get_project_version,platform_server))

default: img

img: $(LINUX_IMG_FULL_PATH) pulseaudio-service
	mkdir mnt
	$(eval LOOPDEVICE := $(shell sudo losetup -f --show $(LINUX_IMG_FULL_PATH) -o $$((2048 * 512)) ))
	@echo "LOOPDEVICE=$(LOOPDEVICE)"
	sudo mount $(LOOPDEVICE) mnt
	cat ~/.ssh/id_rsa.pub > mnt/home/nubo/.ssh/authorized_keys
	cat ~/.ssh/id_rsa.pub > mnt/opt/Android/authorized_keys
	cat mnt/home/nubo/.ssh/id_rsa.pub >> mnt/opt/Android/authorized_keys
	sudo rsync ./ mnt/opt/platform_server/ -raF
	@echo "You can change files on platform. Please enter any key to continue and close image";
	@bash -c "read -sn 1";
	sudo umount mnt
	sudo losetup -d $(LOOPDEVICE)
	rmdir mnt

deb: $(nubo_proj_dir)/debs/latest/platform-server-$(platform_server_version)-$(platform_server_buildid).deb

$(nubo_proj_dir)/debs/latest/platform-server-$(platform_server_version)-$(platform_server_buildid).deb:
	NUBO_PROJ_PATH=$(nubo_proj_dir) \
	PROJ_PATH=$(current_dir) \
	Version=$(platform_server_version).$(platform_server_buildid) \
	./debbuilder/platform_server/debbuilder.sh && \
	fakeroot dpkg-deb -b debbuild/platform_server $(nubo_proj_dir)/debs/latest/platform-server-$(platform_server_version)-$(platform_server_buildid).deb

rpm: $(nubo_proj_dir)/rpms/latest/nuboplatform_server-$(platform_server_version)-$(platform_server_buildid).noarch.rpm

$(nubo_proj_dir)/rpms/latest/nuboplatform_server-$(platform_server_version)-$(platform_server_buildid).noarch.rpm:
	NUBO_PROJ_PATH=$(nubo_proj_dir) \
	PROJ_PATH=$(current_dir) \
	rpmbuild -v \
	--define "_topdir $(current_dir)/rpmbuild" \
	--define "_version $(platform_server_version)" \
	--define "_release $(platform_server_buildid)" \
	-ba rpmbuild/platform_server.spec
	cp $(nubo_proj_dir)/platform_server/rpmbuild/RPMS/noarch/nuboplatform_server-$(platform_server_version)-$(platform_server_buildid).noarch.rpm $(nubo_proj_dir)/rpms/latest/

$(LINUX_IMG_FULL_PATH):
	scp nubo@lab2.nubosoftware.com:N7/linux.img $(LINUX_IMG_FULL_PATH)

pulseaudio-service: pulseaudio-service.cpp
	g++ pulseaudio-service.cpp -o pulseaudio-service -lpulse -lpthread -lpulse-simple

.PHONY: deb default img rpm

