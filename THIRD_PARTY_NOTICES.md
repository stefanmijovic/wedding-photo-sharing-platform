# Third-party notices

This project is MIT-licensed, but bundled libraries and assets remain subject to their own terms.

| Component | License | Upstream | Evidence |
| --- | --- | --- | --- |
| Bootstrap 5.0.0 | MIT | https://github.com/twbs/bootstrap | Version/copyright header in `frontend/css/bootstrap.min.css`; upstream license. |
| GLightbox | MIT | https://github.com/biati-digital/glightbox | Upstream repository identifies the project as MIT. Bundled minified files omit a readable version header. |
| Plyr | MIT | https://github.com/sampotts/plyr | Upstream package metadata identifies MIT. Bundled minified files omit a readable version header. |
| Animate.css 3.5.2 | MIT | https://github.com/animate-css/animate.css | Embedded file header. |
| WOW.js 1.3.0 | MIT | https://github.com/graingert/WOW | Embedded file header. |
| Waypoints | MIT | https://github.com/imakewebthings/waypoints | Embedded file header and upstream license link. |
| Lightbox2 | MIT | https://github.com/lokesh/lightbox2 | Embedded file header. |
| jQuery Easing 1.4.1 | BSD | https://github.com/gdsmith/jquery.easing | Embedded file header. |

The frontend also loads Google Fonts, jQuery, and Bootstrap JavaScript from their respective CDNs; deployments should review CDN privacy, availability, integrity, and license requirements.

Backend direct dependencies declare permissive licenses compatible with distribution of the project's original code under MIT: MIT, BSD-2-Clause, or Apache-2.0. This review does not replace a release-time software-composition analysis. Four installed transitive package manifests (`beep-boop`, `busboy`, `nw-pre-gyp-module-test`, and `streamsearch`) did not expose a license value in their `package.json`; verify their bundled license files/upstream records before a formal release.

## Asset review required

The images and screenshots under `frontend/img/` and `docs/img/` were already present in the public-repository working copy. Their provenance and redistribution rights could not be established from repository metadata. Do not claim that they are freely licensed. The repository owner must verify rights or replace/remove them before public release.
