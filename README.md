
`micrio` is a command line tool for processing and uploading images directly from your computer to the [Micrio Dashboard](https://micr.io).

## Prerequisites

You need to have `libvips` installed on your system, as per their [install instructions](https://www.libvips.org/install.html).

## Quick Start

```bash
# install it as a global binary
npm i -g micrio.cli
```

```bash
# open the Micrio dashboard and navigate to the folder you want to place your images
# ie. https://dash.micr.io/my-group/my-project

# log in first
micrio login
# and then deploy it
micrio upload my-image.jpg -d https://dash.micr.io/my-group/my-project
# now reload your dashboard page, and the image should be there!
```



For more detailed information about configuration, refer to the [documentation](https://doc.micr.io/).

## Commands

### `micrio login`

Connect the `micrio` executable to your logged in Micrio account

### `micrio logout`

Remove your Micrio account credentials

### `micrio upload <images> --destination <url> --format <webp|jpg> --type <2d|360|omni>`

Process and upload one or several images (wildcards are supported) to the specified destination URL, which is the deeplink of the target folder in your Micrio Dashboard.

By default, it processes images to `webp` tiles, but you can change that to `jpg` using the `--format` option.

You can also process it as an equirectangular 360º image, using `--type=360`. For selected accounts, Omni (360º object photography) is also available. Check out [our website](https://micr.io/) for more information.

For more commands and options, refer to the [documentation](https://doc.micr.io) or run `micrio help [command]`.

## Documentation

For the latest Wrangler documentation, [click here](https://doc.micr.io/).
