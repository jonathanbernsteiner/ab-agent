// The SAP CSV column mapping lives in ONE place so a new customer's export can
// be adapted without touching parser code (spec §SAP CSV reality).

export interface ColumnMapping {
  delimiter: string;
  decimal_sep: string;
  date_format: string;
  encoding: "utf-8" | "latin1";
  // logical field -> exact CSV column header
  mapping: Record<LogicalField, string>;
}

export type LogicalField =
  | "po_number"
  | "position"
  | "article"
  | "article_desc"
  | "ordered_qty"
  | "unit_price"
  | "currency"
  | "requested_date"
  | "po_date"
  | "supplier"
  | "confirmed_date";

export const DEFAULT_MAPPING: ColumnMapping = {
  delimiter: ";",
  decimal_sep: ",",
  date_format: "dd.mm.yyyy",
  encoding: "latin1",
  mapping: {
    po_number: "Bestellnr",
    position: "Pos",
    article: "Material",
    article_desc: "Kurztext",
    ordered_qty: "Menge",
    unit_price: "Preis",
    currency: "Waehrung",
    requested_date: "Wunschtermin",
    po_date: "Belegdatum",
    supplier: "Lieferant",
    confirmed_date: "Bestaetigt",
  },
};

// Forgiving header synonyms — used only when a mapped header isn't found
// verbatim, so slightly different customer exports still line up.
export const HEADER_SYNONYMS: Record<LogicalField, string[]> = {
  po_number: ["bestellnr", "bestellnummer", "bestellung", "belegnummer", "ebeln", "po", "po_number"],
  position: ["pos", "position", "item", "ebelp", "posnr"],
  article: ["material", "material_no", "artikel", "artikelnr", "matnr", "sku"],
  article_desc: ["kurztext", "bezeichnung", "description", "text", "maktx", "beschreibung"],
  ordered_qty: ["menge", "bestellmenge", "menge_best", "qty_ordered", "qty", "anzahl"],
  unit_price: ["preis", "einzelpreis", "nettopreis", "netpr", "price_eur", "preis_eur", "wert"],
  currency: ["waehrung", "währung", "waers", "currency"],
  requested_date: ["wunschtermin", "lieferdatum", "requested_delivery", "wunschdatum", "eindt", "termin"],
  po_date: ["belegdatum", "bestelldatum", "po_date", "best.datum", "bedat", "po_datum", "erfassungsdatum"],
  supplier: ["lieferant", "lieferantenname", "supplier", "name1", "vendor", "kreditor"],
  confirmed_date: ["bestaetigt", "bestätigt", "confirmed_delivery", "bestätigtertermin", "confirmed", "eta"],
};
