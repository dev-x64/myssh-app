# How the installer's disk image looks when opened: the app on the left, the
# Applications folder on the right, and a picture behind them that says to
# drag one onto the other. Read by dmgbuild, which the release script runs:
#
#   dmgbuild -s scripts/dmg-settings.py -D app=<MySSH.app> \
#       -D background=src-tauri/dmg/background.tiff -D icon=<icon.icns> "MySSH" out.dmg
#
# The picture is 660 × 440 points and is drawn for these two places; move
# them only together with it (src-tauri/dmg/background.html). It is light
# because the Finder writes the icons' names in black on any picture.

import os.path

application = defines["app"]  # noqa: F821 - given on the command line
name = os.path.basename(application)

format = "UDZO"
compression_level = 9
files = [application]
symlinks = {"Applications": "/Applications"}
icon = defines.get("icon")  # noqa: F821 - the volume's own icon
background = defines["background"]  # noqa: F821

# Centres of the two icons, in points from the window's top left corner.
icon_locations = {name: (180, 170), "Applications": (480, 170)}
icon_size = 120
text_size = 13
label_pos = "bottom"

# The picture's size, plus the title bar.
window_rect = ((240, 160), (660, 468))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
include_icon_view_settings = True
arrange_by = None
grid_offset = (0, 0)
grid_spacing = 100
scroll_position = (0, 0)
