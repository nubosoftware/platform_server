
mkfile_path := $(word $(words $(MAKEFILE_LIST)),$(MAKEFILE_LIST))
nubo_proj_dir:=$(shell cd $(shell dirname $(mkfile_path))/..; pwd)
LINUX_IMG_FULL_PATH:=$(nubo_proj_dir)/nuboplatform/out/target/product/x86_platform/linux.img

current_dir := $(shell pwd)

include NuboVersion.txt
VERSIONLINE=$(MAJOR).$(MINOR).$(PATCHLEVEL)

default: img

img: $(LINUX_IMG_FULL_PATH)
	mkdir mnt
	$(eval LOOPDEVICE := $(shell sudo losetup -f --show $(LINUX_IMG_FULL_PATH) -o $$((2048 * 512)) ))
	@echo "LOOPDEVICE=$(LOOPDEVICE)"
	sudo mount $(LOOPDEVICE) mnt
	cat ~/.ssh/id_rsa.pub > mnt/home/nubo/.ssh/authorized_keys
	cat ~/.ssh/id_rsa.pub > mnt/opt/Android/authorized_keys
	cat mnt/home/nubo/.ssh/id_rsa.pub >> mnt/opt/Android/authorized_keys
	rsync ./ mnt/opt/platform_server/ -raF
	@echo "You can change files on platform. Please enter any key to continue and close image";
	@bash -c "read -sn 1";
	sudo umount mnt
	sudo losetup -d $(LOOPDEVICE)
	rmdir mnt

deb:
	NUBO_PROJ_PATH=$(nubo_proj_dir) \
	PROJ_PATH=$(current_dir) \
	Version=$(VERSIONLINE).$(BUILDID) \
	./debbuilder/platform_server/debbuilder.sh && \
	fakeroot dpkg-deb -b debbuild/platform_server $(nubo_proj_dir)/debs/latest/platform-server-$(VERSIONLINE)-$(BUILDID).deb

rpm:
	NUBO_PROJ_PATH=$(nubo_proj_dir) \
	PROJ_PATH=$(current_dir) \
	rpmbuild -v \
	--define "_topdir $(current_dir)/rpmbuild" \
	--define "_version $(VERSIONLINE)" \
	--define "_release $(BUILDID)" \
	-ba rpmbuild/platform_server.spec
	cp $(nubo_proj_dir)/platform_server/rpmbuild/RPMS/noarch/nuboplatform_server-$(VERSIONLINE)-$(BUILDID).noarch.rpm $(nubo_proj_dir)/rpms/latest/

$(LINUX_IMG_FULL_PATH):
	scp nubo@lab2.nubosoftware.com:N4.4/linux.img $(LINUX_IMG_FULL_PATH)

.PHONY: img rpm

