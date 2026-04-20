# debian/

`debian/` is the static template for the rollio `.deb`. `build.sh` treats
this whole tree as the package root: it copies `debian/` into the staging
directory, layers the freshly-built Rust binaries (`/usr/bin/`) and UI
bundles (`/usr/share/rollio/`) on top, then runs `dpkg-deb --build`.
Nothing else outside this directory is needed at pack time, so packaging
no longer reaches into `third_party/`.

```
debian/
├── DEBIAN/
│   ├── control.in   # template; build.sh substitutes @DEB_VERSION@,
│   │                #            @DEB_ARCH@, @SHLIBS@ at pack time
│   ├── postinst     # CAN module loads + udev/systemd reload (configure)
│   └── postrm       # udev/systemd reload, prune /etc/udev/rules.d/*airbot* on purge
├── bin/             # → /bin/ (== /usr/bin via Ubuntu usrmerge)
│   ├── bind_airbot_device
│   ├── can_add.sh
│   └── slcan_add.sh
└── lib/             # → /lib/
    ├── systemd/system/slcan@.service
    └── udev/rules.d/{90-usb-can.rules,90-usb-slcan.rules}
```

The CAN helper scripts, udev rules, and `slcan@.service` were originally
sourced from `third_party/airbot-play-rust/root/`. They are now vendored
here so the rollio packaging is self-contained; if upstream changes those
files, refresh the copies in this directory.

Edit files in place. The staged tree under `.deb-staging/rollio/` is wiped
and recreated on every `./build.sh core` run.
