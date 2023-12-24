/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';


Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'create_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'replace_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');


const ProfileIdPerformance = 'performance';
const ProfileIdBalanced = 'balanced';
const ProfileIdPowerSaver = 'power-saver';

const TlpProxy = GObject.registerClass({
    GTypeName: 'TlpProxy',
    Properties: {
        'activeProfile': GObject.ParamSpec.string(
            'activeProfile',
            'Active Profile',
            'Change active profile',
            GObject.ParamFlags.READWRITE,
            null
        )
    },
    Signals: {
        'activeProfileChanged': {
            param_types: [GObject.TYPE_STRING],
        },
    },
}, class TlpProxy extends GObject.Object {
    constructor(constructProperties = {}) {
        super(constructProperties);

        const homePath = GLib.get_home_dir();
        this._userProfileDir = GLib.build_filenamev([homePath, ".tlp_profile"]);
        this._activeProfileDir = "/etc/tlp.d/";
        this._activeProfileName = "_tlp_extension_profile.conf";
        this._activeProfileId = ''

        // 3 config
        this._profiles = [
            {
                id: ProfileIdPerformance,
                profileName: `${ProfileIdPerformance}.conf`,
                profilePath: GLib.build_filenamev([this._userProfileDir, `${ProfileIdPerformance}.conf`]),
                description: "this profile is for performance mode",
                name: _("Performance"),
                enabled: true,
                indicatorIcon: "power-profile-performance-symbolic"
            },
            {
                id: ProfileIdBalanced,
                profileName: `${ProfileIdBalanced}.conf`,
                profilePath: GLib.build_filenamev([this._userProfileDir, `${ProfileIdBalanced}.conf`]),
                description: "this profile is for balanced mode",
                name: _("Balanced"),
                enabled: true,
                indicatorIcon: "power-profile-balanced-symbolic.svg"
            },
            {
                id: ProfileIdPowerSaver,
                profileName: `${ProfileIdPowerSaver}.conf`,
                profilePath: GLib.build_filenamev([this._userProfileDir, `${ProfileIdPowerSaver}.conf`]),
                description: "this profile is for power-saver mode",
                name: _("Power-saver"),
                enabled: true,
                indicatorIcon: "power-profile-power-saver-symbolic.svg"
            }
        ];
    }

    getProfiles() {
        return this._profiles;
    }

    getProfile(profileId) {
        for (const p of this._profiles) {
            if (p.id === profileId)
                return p;
        }
        return null;
    }

    get activeProfile() {
        return this._activeProfileId;
    }

    set activeProfile(profileId) {
        if (this._activeProfileId === profileId)
            return;

        this._switchProfile(profileId).catch(r => {
            console.error("failed to switch profile", r);
        })
    }

    async loadProfileConfig() {
        // detect tlp config path
        const systemProfileDir = Gio.File.new_for_path(this._activeProfileDir);
        if (!await systemProfileDir.query_exists(null)) {
            console.error("not found tlp dir %s, maybe tlp not installed", this._activeProfileDir);
            for (let c of this._profiles) {
                c.enabled = false;
            }
            return;
        }

        // find out with profile is active
        const activeProfilesIter = await systemProfileDir.enumerate_children_async('standard::*', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
        for await (const info of activeProfilesIter) {
            if (info.get_name() === this._activeProfileName) {
                const path = GLib.build_filenamev([this._activeProfileDir, info.get_name()]);
                const activeProfile = Gio.File.new_for_path(path);
                const activeProfileStream = await activeProfile.read_async(GLib.PRIORITY_DEFAULT, null);
                const headerBytes = await activeProfileStream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null);
                const decoder = new TextDecoder('utf-8');
                const headerContent = decoder.decode(headerBytes.get_data());
                const firstLineEnd = headerContent.search('\n');
                const firstLine = headerContent.substring(0, firstLineEnd).trim();
                let currentActiveProfileId = '';
                for (let c of this._profiles) {
                    const pos = firstLine.search(c.id);
                    if (pos !== -1) {
                        currentActiveProfileId = c.id;
                        break;
                    }
                }
                if (currentActiveProfileId.length !== 0) {
                    this._setActiveProfileId(currentActiveProfileId);
                    break;
                }
            }
        }

        // detect and create user config path
        console.info("visit %s", this._userProfileDir);
        const userProfileDir = Gio.File.new_for_path(this._userProfileDir);
        if (!await userProfileDir.query_exists(null)) {
            const createUserProfileDirSuccess = await userProfileDir.make_directory_async(GLib.PRIORITY_DEFAULT, null);
            if (createUserProfileDirSuccess) {
                console.info("create user profile dir %s", this._userProfileDir);
            } else {
                console.error("failed to create profile dir %s", this._userProfileDir);
            }
        }

        // detect and create user configs
        console.info("visit %s: configs", this._userProfileDir);
        for (let c of this._profiles) {
            c.enabled = this._detectProfile(c);
        }
    }

    /**
     * Try to find user defined tlp profiles, if not, create an empty one
     * @param profile
     * @returns {Promise<boolean>}
     * @private
     */
    async _detectProfile(profile) {
        let fileExists = false;
        const profileFile = Gio.File.new_for_path(profile.profilePath);
        if (!await profileFile.query_exists(null)) {
            const profileStream = await profileFile.create_async(Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, null);
            if (profileStream) {
                const comment = `# This file is generated by tlp profile extension, ${profile.description}. Change configuration satisfying your requirement`
                const data = new GLib.Bytes(comment);
                await profileStream.write_bytes_async(data, GLib.PRIORITY_DEFAULT, null);
                fileExists = true;
            }
        } else {
            fileExists = true;
        }
        return fileExists;
    }

    async _switchProfile(profileId) {
        console.debug("start switch profile to", profileId)
        for (const p of this._profiles) {
            if (p.id === profileId) {
                const sourceProfile = p.profilePath;
                const target = GLib.build_filenamev([this._activeProfileDir, this._activeProfileName])

                // generate profile
                const tmpPath = GLib.build_filenamev([this._userProfileDir, ".tmp_tlp_profile.conf"])
                const tmpFile = Gio.File.new_for_path(tmpPath);
                const tmpStream = await tmpFile.replace_async(null, false, Gio.FileCreateFlags.NONE, null, null);
                const comment = `# ${p.id}\n# Generated by tlp profile, Do not change!\n`
                const profileHeadData = new GLib.Bytes(comment);
                await tmpStream.write_bytes_async(profileHeadData, GLib.PRIORITY_DEFAULT, null);

                const sourceProfileFile = Gio.File.new_for_path(sourceProfile);
                const sourceStream = await sourceProfileFile.read_async(GLib.PRIORITY_DEFAULT, null);
                let profileContent = ''
                do {
                    profileContent = await sourceStream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null);
                    await tmpStream.write_bytes_async(profileContent, GLib.PRIORITY_DEFAULT, null);
                } while (profileContent.get_size() !== 0)

                // copy to tlp config dir
                const proc = Gio.Subprocess.new(['/usr/bin/pkexec', 'cp', tmpPath, target],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

                const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
                await tmpFile.delete_async(GLib.PRIORITY_DEFAULT, null);
                if (stderr.length !== 0) {
                    throw stderr;
                }

                this._setActiveProfileId(profileId);
            }
        }
    }

    _setActiveProfileId(id) {
        this._activeProfileId = id;
        this.notify('activeProfile');
        this.emit('activeProfileChanged', id);
    }
});


const TlpProfileMenuToggle = GObject.registerClass(
    class TlpProfileMenuToggle extends QuickSettings.QuickMenuToggle {
        constructor(tlpConfig) {
            super({
                title: _('TLP Mode'),
                iconName: 'speedometer-symbolic',
                toggleMode: true,
            });
            this.menu.setHeader('speedometer-symbolic', _('Power Mode'), _('Switch tlp profile'));

            const profiles = tlpConfig.getProfiles();
            this._profileSection = new PopupMenu.PopupMenuSection();
            for (const p of profiles) {
                if (p.enabled) {
                    const item = new PopupMenu.PopupImageMenuItem(p.name, p.indicatorIcon);
                    item.connect('activate',
                        () => {
                            tlpConfig.activeProfile = p.id;
                        }
                    );
                    tlpConfig.connect("activeProfileChanged", (sender, profile) => {
                        item.setOrnament(p.id === profile ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
                    })
                    this._profileSection.addMenuItem(item);
                }
            }
            tlpConfig.connect("activeProfileChanged", (sender, profile) => {
                this.checked = profile !== ProfileIdBalanced;
            })
            this.menu.addMenuItem(this._profileSection);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this.connect('clicked', () => {
                tlpConfig.activeProfile = tlpConfig.activeProfile === ProfileIdBalanced ? ProfileIdPowerSaver : ProfileIdPerformance;
            });
        }
    });


const TlpProfileIndicator = GObject.registerClass(
    class TlpProfileIndicator extends QuickSettings.SystemIndicator {
        constructor() {
            super();

            this._indicator = this._addIndicator();
            this._indicator.iconName = 'power-symbolic';
            this._tlpConfig = new TlpProxy();

            const toggle = new TlpProfileMenuToggle(this._tlpConfig);

            this._tlpConfig.connect("activeProfileChanged", (sender, profile) => {
                const p = this._tlpConfig.getProfile(profile)
                if (p !== null) {
                    this._indicator.iconName = p.indicatorIcon;
                }
                this.visible = profile !== ProfileIdBalanced;
            })
            this.quickSettingsItems.push(toggle);

            this._tlpConfig.loadProfileConfig().catch(r => {
                console.error("failed to init tlp profile", r)
            });
        }
    });


export default class QuickSettingsExampleExtension extends Extension {
    enable() {
        this._indicator = new TlpProfileIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
    }
}
