include $(TOPDIR)/rules.mk

PKG_NAME:=alist-encrypt-tjs
PKG_VERSION:=0.3.0
PKG_RELEASE:=10
PKG_LICENSE:=MIT
PKG_MAINTAINER:=local OpenWrt port

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)

include $(INCLUDE_DIR)/package.mk

define Package/alist-encrypt-tjs
  PKGARCH:=all
  SECTION:=net
  CATEGORY:=Network
  TITLE:=alist-encrypt proxy for txiki.js
  DEPENDS:=+txiki-js
endef

define Package/alist-encrypt-tjs/description
 alist-encrypt proxy bundled for OpenWrt txiki.js with procd service,
 persistent configuration, static UI, and file conversion command.
endef

define Package/alist-encrypt-tjs/conffiles
/etc/config/alist-encrypt
endef

define Build/Prepare
	test -f "$(ALIST_ENCRYPT_SOURCE_DIR)/server.mjs"
	test -f "$(ALIST_ENCRYPT_SOURCE_DIR)/convert.mjs"
	test -f "$(ALIST_ENCRYPT_SOURCE_DIR)/prga-worker.mjs"
	test -d "$(ALIST_ENCRYPT_SOURCE_DIR)/public"
	rm -rf "$(PKG_BUILD_DIR)"
	mkdir -p "$(PKG_BUILD_DIR)"
	$(CP) "$(ALIST_ENCRYPT_SOURCE_DIR)/server.mjs" "$(PKG_BUILD_DIR)/"
	$(CP) "$(ALIST_ENCRYPT_SOURCE_DIR)/convert.mjs" "$(PKG_BUILD_DIR)/"
	$(CP) "$(ALIST_ENCRYPT_SOURCE_DIR)/prga-worker.mjs" "$(PKG_BUILD_DIR)/"
	$(CP) "$(ALIST_ENCRYPT_SOURCE_DIR)/public" "$(PKG_BUILD_DIR)/"
endef

define Build/Compile
endef

define Package/alist-encrypt-tjs/install
	$(INSTALL_DIR) $(1)/usr/lib/alist-encrypt
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/server.mjs $(1)/usr/lib/alist-encrypt/server.mjs
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/convert.mjs $(1)/usr/lib/alist-encrypt/convert.mjs
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/prga-worker.mjs $(1)/usr/lib/alist-encrypt/prga-worker.mjs
	$(CP) $(PKG_BUILD_DIR)/public $(1)/usr/lib/alist-encrypt/
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/alist-encrypt-convert $(1)/usr/bin/alist-encrypt-convert
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/alist-encrypt.init $(1)/etc/init.d/alist-encrypt
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/alist-encrypt.config $(1)/etc/config/alist-encrypt
	$(INSTALL_DIR) $(1)/etc/alist-encrypt
endef

$(eval $(call BuildPackage,alist-encrypt-tjs))
