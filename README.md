# ICD-10-GM / OPS Catalogue Explorer

Interactive browser for the German ICD-10-GM and OPS clinical code hierarchies.
Codes are displayed as an expandable network graph.

Year-to-year mapping information is also displayed, extracted from the BfArM Umsteiger transition tables which mapps each code for year to year. 

**On AI usage**
The code was almost entirely generated using Claude Sonnet.
![AI Usage](https://img.shields.io/badge/👤_█████████░_🤖-90%25_AI-e879f9?style=flat-square)

## Features

- Browse the full ICD-10-GM and OPS code hierarchy as a network graph
- Search by label or code prefix (comma-separated terms, include + exclude)
- Click-to-expand subtrees in explore mode
- Year slider to explore how the catalogue changed from 2014 to 2026
- Feature builder: select codes into a named group and copy as a Python list
- Year-to-year mapping information on leaf nodes on the right pannel

## Data

### Data source

The catalogue data is parsed from the official XML files published by (Bundesinstitut für Arzneimittel und Medizinprodukte),
covering ICD-10-GM and OPS for years 2014–2026, as well as the corresponding BfArM Umsteiger transition tables.
The raw XML and Umsteiger text files are not included in this repository. To regenerate the XML data:

1. Download the XML files from BfArM
2. Parse them into `catalogue.parquet` (see `dash_app/data.py`)
3. Export to the web format: `uv run --project dash_app python scripts/export_data.py`

The generation code for the transistion table from the raw Umsteiger text files is not provided in the repo. 

### Official aknowledgement (in german)

#### OPS (Operationen- und Prozedurenschlüssel)
Herausgegeben vom Bundesinstitut für Arzneimittel und Medizinprodukte (BfArM) im Auftrag des Bundesministeriums für Gesundheit (BMG).
Die Erstellung erfolgt unter Verwendung der maschinenlesbaren Fassung des Bundesinstituts für Arzneimittel und Medizinprodukte (BfArM).

#### ICD-10-GM (Internationale statistische Klassifikation der Krankheiten und verwandter Gesundheitsprobleme, 10. Revision, German Modification)

Die vorliegende Ausgabe beruht auf der vollständigen amtlichen Fassung der Internationalen statistischen Klassifikation der Krankheiten und verwandter Gesundheitsprobleme, 10. Revision, sowie auf der australischen ICD-10-AM, First Edition.
© Weltgesundheitsorganisation (WHO) 1992
© Commonwealth of Australia 1998
Herausgegeben vom Bundesinstitut für Arzneimittel und Medizinprodukte (BfArM) im Auftrag des Bundesministeriums für Gesundheit (BMG).
Die Erstellung erfolgt unter Verwendung der maschinenlesbaren Fassung des Bundesinstituts für Arzneimittel und Medizinprodukte (BfArM).


## Repository structure

```
catalogue_explorer/
├── dash_app/          # Original Python/Dash app
│   ├── app.py
│   ├── data.py
│   ├── layout.py
│   └── pyproject.toml
├── web/               # React app (deployed to Netlify)
│   ├── public/
│   │   └── catalogue.json.gz
│   │   └──transitions.json.gz
│   ├── src/
│   │   ├── data.js    # BFS + search logic
│   │   └── App.jsx    # UI
│   │   └── main.jsx
│   │   └── transition.js # transistion parsing
│   └── netlify.toml
└── scripts/
    └── export_data.py # parquet → catalogue.json.gz and transitions.json.gz
```

## Run locally

### Web app (React)

```bash
cd web
npm install
npm run dev
```

### Dash app (Python)
Note: code transition feature not available in the dash app.
```bash
cd dash_app
uv sync
uv run python app.py
```

## Live app

The web app is deployed on netifly: [icd-ops-catalogue-explorer](https://icd-ops-catalogue-explorer.netlify.app/)
