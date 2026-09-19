export type FallbackWay = {
  id: number;
  tags: Record<string, string>;
  geometry: { lat: number; lon: number }[];
};

// Small embedded fail-safe map so gameplay never waits on a public API.
// Coordinates approximate the Marine Drive / Churchgate street pattern.
// Live OpenStreetMap data replaces this layer in the background when available.
export const FALLBACK_WAYS: FallbackWay[] = [
  {
    id: 1,
    tags: { highway: 'primary', name: 'Marine Drive' },
    geometry: [
      { lat: 18.9262, lon: 72.8239 },
      { lat: 18.9302, lon: 72.8244 },
      { lat: 18.9345, lon: 72.8248 },
      { lat: 18.9389, lon: 72.8245 },
      { lat: 18.9432, lon: 72.8234 },
      { lat: 18.9473, lon: 72.8217 },
      { lat: 18.9508, lon: 72.8196 },
      { lat: 18.9535, lon: 72.8173 },
      { lat: 18.9556, lon: 72.8152 }
    ]
  },
  {
    id: 2,
    tags: { highway: 'secondary', name: 'Churchgate Road' },
    geometry: [
      { lat: 18.9328, lon: 72.8247 },
      { lat: 18.9329, lon: 72.8273 },
      { lat: 18.9330, lon: 72.8300 }
    ]
  },
  {
    id: 3,
    tags: { highway: 'secondary', name: 'Veer Nariman Road' },
    geometry: [
      { lat: 18.9292, lon: 72.8242 },
      { lat: 18.9295, lon: 72.8270 },
      { lat: 18.9300, lon: 72.8302 }
    ]
  },
  {
    id: 4,
    tags: { highway: 'tertiary', name: 'Dinshaw Vacha Road' },
    geometry: [
      { lat: 18.9370, lon: 72.8247 },
      { lat: 18.9370, lon: 72.8270 },
      { lat: 18.9372, lon: 72.8297 }
    ]
  },
  {
    id: 5,
    tags: { highway: 'secondary', name: 'Maharshi Karve Road' },
    geometry: [
      { lat: 18.9412, lon: 72.8240 },
      { lat: 18.9418, lon: 72.8267 },
      { lat: 18.9424, lon: 72.8295 }
    ]
  },
  {
    id: 6,
    tags: { highway: 'tertiary', name: 'Marine Lines Cross Road' },
    geometry: [
      { lat: 18.9457, lon: 72.8225 },
      { lat: 18.9464, lon: 72.8250 },
      { lat: 18.9471, lon: 72.8278 }
    ]
  },
  {
    id: 7,
    tags: { highway: 'secondary', name: 'Princess Street Link' },
    geometry: [
      { lat: 18.9497, lon: 72.8203 },
      { lat: 18.9507, lon: 72.8230 },
      { lat: 18.9516, lon: 72.8261 }
    ]
  },
  {
    id: 8,
    tags: { highway: 'tertiary', name: 'Charni Road Link' },
    geometry: [
      { lat: 18.9532, lon: 72.8175 },
      { lat: 18.9542, lon: 72.8202 },
      { lat: 18.9550, lon: 72.8231 }
    ]
  },
  {
    id: 9,
    tags: { highway: 'tertiary', name: 'Inner South Road' },
    geometry: [
      { lat: 18.9280, lon: 72.8272 },
      { lat: 18.9340, lon: 72.8271 },
      { lat: 18.9400, lon: 72.8268 },
      { lat: 18.9460, lon: 72.8258 },
      { lat: 18.9520, lon: 72.8236 }
    ]
  },
  {
    id: 10,
    tags: { highway: 'residential', name: 'Inner East Road' },
    geometry: [
      { lat: 18.9300, lon: 72.8298 },
      { lat: 18.9360, lon: 72.8296 },
      { lat: 18.9420, lon: 72.8292 },
      { lat: 18.9480, lon: 72.8276 }
    ]
  }
];
