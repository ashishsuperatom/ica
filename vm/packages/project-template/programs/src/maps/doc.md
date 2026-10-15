# maps

An EXAMPLE of a front-end package in a program, the usual web way: Mapbox GL listed in package.json, imported in
web/index.tsx (`import mapboxgl from 'mapbox-gl'`, `import 'mapbox-gl/dist/mapbox-gl.css'`). Run `pnpm install` here;
`sacli agent push` (or `sacli program build`) bundles what the web side imports. Any other package is added the same way.

`MapView` (`@lib/maps`): a Mapbox public token (`pk.…` — each project its own, kept in a setting, never here), a
centre and zoom, and points (a place, a label and a value: a circle sized by its value; a click hands it back).
