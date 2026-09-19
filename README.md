# EarthKart — Marine Drive POC

EarthKart turns real OpenStreetMap roads into browser-native arcade racing spaces.

This first vertical slice deliberately stays small:

- **Location:** Marine Drive / South Mumbai
- **Map source:** OpenStreetMap via public Overpass endpoints
- **Rendering:** Three.js + WebGL2
- **Physics:** Rapier WASM
- **World generation:** OSM highways become instanced road meshes; OSM building footprints become lightweight city massing
- **Performance:** instanced road/building geometry and capped device pixel ratio
- **No backend or multiplayer yet**

## Why this architecture

Hop.Earth validates the larger pattern: separate real-world road geometry, elevation and game simulation. EarthKart starts with the minimum client-side version so driving feel and visual quality can be tested before adding planet-scale tile infrastructure.

## Run

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

## Controls

- `W` / Up — accelerate
- `S` / Down — brake / reverse
- `A D` / arrows — steer
- `R` — reset kart

## Data note

This POC uses free public Overpass API endpoints for one small fixed bounding box. That is suitable for development, not production traffic. The production EarthKart map pipeline should move to cached/vector-tile road data and separate terrain/elevation tiles before opening arbitrary worldwide locations.

Map data © OpenStreetMap contributors.
