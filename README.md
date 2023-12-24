# Tlp Profile

TlpProfile is a gnome extension that help you switch different profiles.

## Dependencies

TLP is required.  
And you might have to **remove power-profiles-daemon**, that may conflict with TLP

## How to use

Once e extension started, directory ~/.tlp_profile/ will be initialized.

Goto directory ~/.tlp_profile/, and there will be three power mode configure(corresponding to power-saver/balanced/performance mode),
edit them in TLP's setting format(refer to TLP document)

Switching profiles just copy target power configure files to /etc/tlp.d/_tlp_extension_profile.conf(accessing the file requires root permission). TLP monitors that directory and will automatically apply changes. 

If some configuration not follow your define,
```shell
tlp-stat -c
```
will be helpful, the output print where the configuration come from. 
