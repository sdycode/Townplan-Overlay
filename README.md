# Map Overlay Aligner

Overlay a PDF or image on a map, then line it up by hand. No API key needed.

## Run
```
cd AppDemo
python3 server.py
```
Open http://localhost:8000

## Use
1. Click **＋ Add PDF / images**. You can pick several files at once, and each becomes a sheet in the list.
2. Click a sheet in the list, or on the map in Adjust mode, to **select** it. Its page, opacity, scale, rotation and stretch appear under **Selected**.
3. **📄 Adjust** (key `A`) moves only the selected sheet: drag to move, scroll to scale, Shift+scroll to rotate. Tick **Adjust all sheets together** (key `T`) to move every visible sheet at once. Hold `Space` to pan or zoom the map with the sheets.
4. **🔒 Locked** (key `L`) pans and zooms the map and all sheets together, for exploring. **🗺 Map only** moves just the map.
5. In the sheet list: the checkbox shows or hides a sheet, ↑ and ↓ change which sheet draws on top, and × removes it. **All sheets opacity** fades every sheet at once, on top of each sheet's own opacity.
6. Each sheet's alignment saves itself in the browser per file and page, and open sheets come back after a page reload. **Export JSON** / **Import JSON** save and load all sheets' alignments as a local file.
7. **☁ Saved alignments** (under Selected) stores named alignments in Firebase. A sheet can have many, and the ★ one is primary: it loads automatically whenever that file and page is added. ▶ applies one, ✎ renames, and 🗑 deletes, but the last one always stays. **Update current** overwrites the highlighted one.
8. **☁ Collections** saves all open sheets with a copy of their alignments under one name. **Load** opens them; any files that aren't open yet are asked for once. **Update** overwrites the collection with the open sheets.
9. **Add from a link:** paste a direct PDF or image link next to 👁, check the preview (choose the page, edit the name), then **Add to map**. Needs `server.py`.
10. Paste a place name, coordinates (e.g. `18°37'21.8"N 73°47'39.0"E`) or any Google Maps link into the search box. Short `maps.app.goo.gl` links need `server.py`.
11. Press `G` to show or hide the land-use legend.

## Firebase setup (one time)
Sheets are identified by **file name + page**; only alignment data is stored, never the files.

1. Open the Firebase console → project **townplanmap-b2aec** → **Build → Realtime Database** → **Create database**. Any location works, and either security mode is fine because you replace the rules next.
2. On the **Rules** tab, paste the following and click **Publish**:
   ```json
   {
     "rules": {
       "overlayAligner": { ".read": true, ".write": true }
     }
   }
   ```
   No sign-in is used, so anyone who knows the database URL can read or change this data. That's fine for a personal tool.
3. Reload the app. Under **☁ Cloud** at the bottom of the panel it should say *connected*. The app finds the database URL by itself. If it doesn't, copy the URL from the top of the Realtime Database page into **Realtime Database URL**, or set `databaseURL` in `firebase-config.js`.

Data layout:
```
overlayAligner/
  sheets/{fileName}/name
  sheets/{fileName}/pages/p{page}/primary              -> alignment id
  sheets/{fileName}/pages/p{page}/alignments/{id}      -> {label, lat, lng, worldW, rot, sx, sy, opacity, blend, zoom, createdAt, updatedAt}
  collections/{id}                                     -> {name, createdAt, updatedAt, items/{fileName_pN}: {name, page, order, visible, alignment}}
```
In keys, `.` and other characters Firebase doesn't allow are URL-encoded, so `Ward 1.pdf` becomes `Ward%201%2Epdf`.
