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
