// A map for any program's view: Mapbox GL, imported as any web project imports it.
import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

export interface MapPoint { id: string; label: string; lng: number; lat: number; value: number; text?: string }

export function MapView({ token, center, zoom = 4, points = [], height = 360, onPick }: {
  token: string; center: [number, number]; zoom?: number; points?: MapPoint[]; height?: number; onPick?: (p: MapPoint) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const markers = useRef<mapboxgl.Marker[]>([])
  useEffect(() => {
    if (!box.current || !token) return
    mapboxgl.accessToken = token
    const m = new mapboxgl.Map({ container: box.current, style: 'mapbox://styles/mapbox/light-v11', center, zoom, attributionControl: true })
    m.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right')
    map.current = m
    const ro = new ResizeObserver(() => m.resize()); ro.observe(box.current)
    return () => { ro.disconnect(); m.remove(); map.current = null }
  }, [token])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = map.current; if (!m) return
    for (const x of markers.current) x.remove()
    const hi = Math.max(1, ...points.map((p) => p.value))
    markers.current = points.map((p) => {
      const el = document.createElement('div')
      const size = 14 + Math.sqrt(p.value / hi) * 46
      Object.assign(el.style, { width: `${size}px`, height: `${size}px`, borderRadius: '50%', background: 'rgba(15,118,110,0.55)', border: '2px solid #0f766e', cursor: onPick ? 'pointer' : 'default' })
      if (onPick) el.addEventListener('click', () => onPick(p))
      return new mapboxgl.Marker({ element: el }).setLngLat([p.lng, p.lat]).setPopup(new mapboxgl.Popup({ offset: size / 2, closeButton: false }).setText(`${p.label}${p.text ? ` — ${p.text}` : ''}`)).addTo(m)
    })
  }, [points, map.current])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!token) return <div style={{ height, display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 'var(--t-sm)' }}>A Mapbox token is needed to draw the map.</div>
  return <div ref={box} style={{ width: '100%', height, borderRadius: 'var(--r-md)', overflow: 'hidden' }} />
}
