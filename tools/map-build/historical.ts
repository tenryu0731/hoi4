/**
 * January 1936 borders, expressed as edits to present-day administrative units.
 *
 * Natural Earth ships today's world, so a map drawn straight from it hands
 * Königsberg to the Soviet Union and Lwów to Ukraine — thirty years of
 * redrawing that had not happened yet when the game opens. There is no
 * public-domain vector map of 1936, so the period is restored the way an
 * atlas footnote would: name the units that changed hands and say who held
 * them, and for the handful of borders that ran through the middle of a
 * modern unit, name the window they ran around.
 *
 * Codes are ISO 3166-2 as carried in the `iso_3166_2` property.
 */

/** Present-day admin-1 unit -> the nation that held it in January 1936. */
export const RETAG_1936: Readonly<Record<string, string>> = {
  // --- German Reich in its Versailles borders, the Saar already returned ---
  'PL-DS': 'GER', // Lower Silesia — Niederschlesien
  'PL-OP': 'GER', // Opole — Oppeln
  'PL-LB': 'GER', // Lubusz — Ostbrandenburg
  'PL-ZP': 'GER', // West Pomerania — Pommern
  'PL-WN': 'GER', // Warmia-Masuria — southern East Prussia
  'RU-KGD': 'GER', // Kaliningrad — Königsberg, East Prussia proper

  // --- The Polish kresy, drawn at Riga in 1921 -----------------------------
  'UA-46': 'POL', // L'viv — Lwów, eastern Galicia
  'UA-61': 'POL', // Ternopil' — Tarnopol
  'UA-26': 'POL', // Ivano-Frankivs'k — Stanisławów
  'UA-07': 'POL', // Volyn — Wołyń
  'UA-56': 'POL', // Rivne — Równe
  'BY-BR': 'POL', // Brest — Polesie
  'BY-HR': 'POL', // Grodno — Nowogródek and Białystok's east
  'LT-VL': 'POL', // Vilnius, held by Poland since 1920 and claimed by Lithuania

  // --- Czechoslovakia's eastern tail ---------------------------------------
  'UA-21': 'CZE', // Transcarpathia — Podkarpatská Rus

  // --- Greater Romania ------------------------------------------------------
  'UA-77': 'ROM', // Chernivtsi — northern Bukovina
  'BG-08': 'ROM', // Dobrich — the Cadrilater, Romanian since 1913
  'BG-19': 'ROM', // Silistra — Durostor

  // --- Italy's Adriatic gains at Rapallo -----------------------------------
  'HR-18': 'ITA', // Istria

  // --- French mandate of Syria, before the Sanjak went to Turkey in 1939 ---
  'TR-31': 'FRA', // Hatay — Alexandretta
};

/** Period names for the units that changed hands, so the map reads as 1936. */
export const RENAME_1936: Readonly<Record<string, string>> = {
  'RU-KGD': 'Königsberg',
  'PL-DS': 'Niederschlesien',
  'PL-OP': 'Oppeln',
  'PL-LB': 'Ostbrandenburg',
  'PL-ZP': 'Pommern',
  'PL-WN': 'Ostpreußen',
  'UA-46': 'Lwów',
  'UA-61': 'Tarnopol',
  'UA-26': 'Stanisławów',
  'UA-07': 'Wołyń',
  'UA-56': 'Równe',
  'BY-BR': 'Polesie',
  'BY-HR': 'Nowogródek',
  'LT-VL': 'Wilno',
  'UA-21': 'Podkarpatská Rus',
  'UA-77': 'Bucovina',
  'BG-08': 'Cadrilater',
  'BG-19': 'Durostor',
  'HR-18': 'Istria',
  'TR-31': 'Alexandretta',
};

/** A lon/lat window in degrees. */
export interface Window {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

/**
 * A border that ran through the middle of a present-day unit. Whatever of
 * `from` falls inside the window becomes a unit of its own under `tag`; the
 * rest stays where it was.
 */
export interface Cut {
  /** An ISO 3166-2 code, or `adm0:XXX` to cut every unit of a country. */
  from: string;
  tag: string;
  name: string;
  window: Window;
}

export const CUTS_1936: readonly Cut[] = [
  // Finland's border stood thirty kilometres from Leningrad until 1940.
  { from: 'RU-LEN', tag: 'FIN', name: 'Viipuri',
    window: { minLon: 27.4, maxLon: 31.6, minLat: 60.2, maxLat: 61.7 } },
  // Ladoga Karelia, lost with the isthmus in the Winter War.
  { from: 'RU-KR', tag: 'FIN', name: 'Sortavala',
    window: { minLon: 29.4, maxLon: 32.1, minLat: 61.0, maxLat: 62.6 } },
  // The Petsamo corridor, Finland's only Arctic coast.
  { from: 'RU-MUR', tag: 'FIN', name: 'Petsamo',
    window: { minLon: 28.0, maxLon: 32.2, minLat: 68.7, maxLat: 70.3 } },
  // Southern Bessarabia — the Budjak, Romanian between the wars.
  { from: 'UA-51', tag: 'ROM', name: 'Cetatea Albă',
    window: { minLon: 28.0, maxLon: 30.3, minLat: 45.2, maxLat: 46.8 } },
  // The Julian March: Italy's border ran east of Gorizia and Postojna.
  { from: 'adm0:SVN', tag: 'ITA', name: 'Venezia Giulia',
    window: { minLon: 13.2, maxLon: 14.35, minLat: 45.3, maxLat: 46.6 } },
  // The Dodecanese, Italian since 1912; the Cyclades to the west stayed Greek.
  { from: 'GR-L', tag: 'ITA', name: 'Dodecaneso',
    window: { minLon: 26.4, maxLon: 29.5, minLat: 34.8, maxLat: 37.6 } },
];

/**
 * Towns whose names had not changed yet, keyed by `NAME|ADM0_A3`.
 *
 * The names are the loudest anachronism on the map: a German Pomerania whose
 * chief town is labelled Koszalin, a Polish Volhynia labelled Rivne, and a
 * Leningrad that will not be called St Petersburg for another fifty-five
 * years. The country code is part of the key because Brest in Brittany is not
 * Brest-Litovsk, and only one of them was Polish.
 */
export const CITY_NAMES_1936: Readonly<Record<string, string>> = {
  // Soviet cities under the names they carried in 1936
  'St.  Petersburg|RUS': 'Leningrad',
  'Volgograd|RUS': 'Stalingrad',
  'Nizhny Novgorod|RUS': 'Gorky',
  'Samara|RUS': 'Kuybyshev',
  'Tver|RUS': 'Kalinin',
  'Kyiv|UKR': 'Kiev',

  // East Prussia and the German east
  'Kaliningrad|RUS': 'Königsberg',
  'Sovetsk|RUS': 'Tilsit',
  'Olsztyn|POL': 'Allenstein',
  'Elbląg|POL': 'Elbing',
  'Szczecin|POL': 'Stettin',
  'Koszalin|POL': 'Köslin',
  'Wrocław|POL': 'Breslau',
  'Opole|POL': 'Oppeln',
  'Zielona Góra|POL': 'Grünberg',
  'Gdańsk|POL': 'Danzig',

  // The Polish kresy
  'Lviv|UKR': 'Lwów',
  'Ternopil|UKR': 'Tarnopol',
  'Ivano-Frankivsk|UKR': 'Stanisławów',
  'Drohobych|UKR': 'Drohobycz',
  'Rivne|UKR': 'Równe',
  'Lutsk|UKR': 'Łuck',
  'Brest|BLR': 'Brześć',
  'Hrodna|BLR': 'Grodno',
  'Pinsk|BLR': 'Pińsk',
  'Baranavichy|BLR': 'Baranowicze',
  'Vilnius|LTU': 'Wilno',

  // Finnish Karelia
  'Vyborg|RUS': 'Viipuri',
  'Svetogorsk|RUS': 'Enso',

  // Greater Romania and Czechoslovak Ruthenia
  'Chernivtsi|UKR': 'Cernăuți',
  'Izmayil|UKR': 'Ismail',
  'Uzhgorod|UKR': 'Užhorod',
  'Dobrich|BGR': 'Bazargic',

  // Italy's Adriatic and Aegean
  'Pula|HRV': 'Pola',
  'Rijeka|HRV': 'Fiume',
  'Rodos|GRC': 'Rodi',
};

/**
 * A region that has to exist as a state of its own because history hands it
 * over on its own.
 *
 * 「ズデーテン地方は割譲できるようにステートだよ」. The reference has the
 * Sudetenland as a separate state for exactly this reason, and the screenshot
 * it was read off cannot show it: at nine hundred and fifty pixels for the
 * whole of Europe, Bohemia is twenty pixels across and its German rim is two,
 * so the extraction merged it into Prague. Left merged, Munich would have
 * ceded the Czech capital in 1938 -- the cession takes the border states by
 * weight, and undivided Bohemia is the heaviest thing on that border.
 *
 * The rim is grown inward from the frontier until it reaches the area the
 * region actually had, rather than being drawn as a shape: the German-settled
 * districts were a belt along the border, and that is a rule rather than an
 * outline.
 */
export interface Carve {
  /** Whose ground it is in January 1936. */
  from: string;
  name: string;
  /** Grown inward from a frontier with any of these. */
  frontierWith: string[];
  /** How much to take, in square kilometres. */
  areaKm: number;
  /** Confined to this window, so a different border of the same country is
   * not swept in with it. */
  window: Window;
}

export const CARVE_1936: readonly Carve[] = [
  {
    // The German-speaking rim of Bohemia, Moravia and Czech Silesia: a
    // horseshoe from Eger round to Troppau, which is what the Munich agreement
    // moved. The window stops at the Moravian gate so that Slovakia's own
    // frontier is left alone.
    //
    // Munich took about 29,000 km2 and this takes 39,000, because the first
    // ring is taken whole and the Czech frontier with Germany and Austria is
    // long enough that one ring of provinces already overruns the figure. The
    // alternative is a rim with a gap in it, and a rim with a gap does not
    // separate Prague from the German border -- which is the whole reason the
    // region needs to be a state.
    from: 'CZE',
    name: 'Sudetenland',
    frontierWith: ['GER', 'AUS'],
    areaKm: 28_000,
    window: { minLon: 11.8, maxLon: 19.0, minLat: 48.4, maxLat: 51.2 },
  },
];

/**
 * How many states each country's ground inside this map is cut into.
 *
 * The reference reads Hearts of Iron's state map by colour, and colour is a
 * poor witness at the edges: it splits Iceland into six and Latvia into seven
 * while reading Germany about right. States came out even-handed in the Reich
 * and shredded everywhere else -- 「ドイツ以外が細すぎる」 -- because a country
 * whose states happen to be drawn in similar colours reads as one region and a
 * country whose single state is cut by a firth or a shading band reads as
 * several. Counting is the one thing the raster cannot do for us, so it is
 * done here.
 *
 * These are the counts the real game uses for the ground each country holds
 * inside this map's bounds, colonies included -- Britain's number covers Egypt
 * and Iraq as well as the British Isles, France's the Maghreb and the Levant,
 * and the Soviet Union's stops at the eastern edge rather than the Pacific.
 *
 * The budget counts states that can reach a compatriot overland. An island
 * with no land neighbour of its own nation -- Malta, Gibraltar, the Canaries,
 * Crete, Gotland -- is a state on top of the budget rather than inside it,
 * because the alternative is folding it into a mainland it cannot be walked
 * to. The real game keeps those separate for the same reason.
 *
 * A country over its budget has its smallest states folded into the neighbour
 * they share the most border with, until it fits. One under its budget is left
 * exactly as it is: a coarse border that exists is better than a fine one
 * invented to hit a number.
 */
export const STATE_BUDGET_1936: Readonly<Record<string, number>> = {
  SOV: 80, ENG: 26, FRA: 31, ITA: 24, SPR: 20, GER: 22, POL: 15, TUR: 14,
  YUG: 10, ROM: 10, GRE: 8, FIN: 7, NOR: 6, POR: 6, PER: 6, SWE: 5, DEN: 5,
  // Czechoslovakia's six is before Munich: the Sudetenland is carved out of
  // the Bohemian rim afterwards, which makes seven on the finished map.
  CZE: 6, AUS: 4, HUN: 4, BUL: 4, IRE: 3, SAU: 3, EST: 2, LAT: 2, LIT: 2,
  SWI: 2, HOL: 2, BEL: 2, ALB: 1, ICE: 1, LUX: 1,
};
