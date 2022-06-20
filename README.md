# page-to-pdf

This plugin requires Google Chrome or Chromium to be installed. It will look in

`/usr/bin/chromium-browser`

and

`/usr/bin/chromium`

for a Chromium executable. On Ubuntu this will be satified by the `chromium-browser` package:

`sudo apt install chromium-browser`.

This is already installed on the DigitalOcean Marketplace Saltcorn 0.6.0+ droplet.

If these are not found it will default to Puppetter's standard Chromium/Google Chrome search path. For instance, it works on macOS with Chromium installed.
