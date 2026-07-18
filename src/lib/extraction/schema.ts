// JSON Schema for the extract_ab tool. Forcing this tool guarantees the model
// returns a structured read of the document (Sonnet 4.6 doesn't support the
// output_config.format structured-outputs feature, so we use forced tool-use).

export const EXTRACT_AB_TOOL = {
  name: "extract_ab",
  description:
    "Record the structured contents of a supplier order confirmation (Auftragsbestätigung / AB). Call this exactly once with everything you read from the document, including findings hidden in prose or footnotes.",
  input_schema: {
    type: "object" as const,
    properties: {
      is_order_confirmation: {
        type: "boolean",
        description:
          "True only if this document is a supplier ORDER CONFIRMATION (Auftragsbestätigung/AB) that references a purchase order. False for invoices, delivery notes, quotes, or unrelated documents.",
      },
      language: {
        type: "string",
        enum: ["de", "en", "other"],
      },
      ab_number: {
        type: ["string", "null"],
        description: "The supplier's own AB / confirmation number, if present.",
      },
      supplier: {
        type: ["string", "null"],
        description: "The supplier / vendor company name.",
      },
      po_number: {
        type: ["string", "null"],
        description:
          "The buyer's purchase-order number this confirmation refers to. It may be buried mid-sentence in prose (e.g. 'zu Ihrer Bestellung 4500112944 vom ...'). Extract the number itself.",
      },
      po_number_context: {
        type: ["string", "null"],
        description:
          "Where/how the PO number appeared (e.g. 'in a sentence in the body', 'in the header table').",
      },
      positions: {
        type: "array",
        description: "One entry per confirmed order line/position.",
        items: {
          type: "object",
          properties: {
            position: { type: ["integer", "null"], description: "Line/position number if shown." },
            article: { type: ["string", "null"], description: "Article / material number." },
            description: { type: ["string", "null"] },
            quantity: { type: ["number", "null"], description: "Confirmed quantity for this line (the whole line; use partial_deliveries for splits)." },
            unit_price: { type: ["number", "null"], description: "Confirmed unit price. IMPORTANT: a changed price is often mentioned only in running text, not in the table — capture it here." },
            currency: { type: ["string", "null"] },
            confirmed_delivery_date: {
              type: ["string", "null"],
              description:
                "Confirmed delivery date as ISO yyyy-mm-dd. If the document gives a calendar week (e.g. 'KW 31'), convert to the Friday of that week and note it in delivery_date_note.",
            },
            delivery_date_note: {
              type: ["string", "null"],
              description: "Original date wording if not a plain date (e.g. 'KW 31', 'Ende August').",
            },
            partial_deliveries: {
              type: "array",
              description: "If the line is split into multiple partial deliveries, list each.",
              items: {
                type: "object",
                properties: {
                  quantity: { type: "number" },
                  delivery_date: { type: ["string", "null"], description: "ISO yyyy-mm-dd." },
                  delivery_date_note: { type: ["string", "null"] },
                },
                required: ["quantity"],
                additionalProperties: false,
              },
            },
            notes: {
              type: ["string", "null"],
              description:
                "Any line-specific finding stated in prose: a price adjustment, 'Wunschtermin kann nicht bestätigt werden', surcharges, etc.",
            },
          },
          required: ["position", "article", "quantity", "unit_price", "confirmed_delivery_date", "partial_deliveries"],
          additionalProperties: false,
        },
      },
      global_notes: {
        type: "array",
        description:
          "Document-level findings found in prose or footnotes that don't belong to a single line (price notices, general delay statements, terms).",
        items: { type: "string" },
      },
      transcript: {
        type: "string",
        description:
          "A faithful plain-text transcription of the document as you read it, preserving the order of tables and prose. This is shown to the user as 'what the AI read'.",
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
      },
    },
    required: [
      "is_order_confirmation",
      "po_number",
      "positions",
      "global_notes",
      "transcript",
      "confidence",
    ],
    additionalProperties: false,
  },
};

export const EXTRACTION_SYSTEM = `Du bist ein Fachassistent für Einkauf. Du liest Auftragsbestätigungen (ABs) von Lieferanten — auf Deutsch oder Englisch, als PDF oder E-Mail-Text — und extrahierst ihren Inhalt strukturiert.

Wichtige Regeln:
- Rufe das Tool "extract_ab" GENAU EINMAL auf. Antworte mit nichts anderem.
- Die Bestellnummer (PO-Nummer) steht oft mitten im Fließtext ("zu Ihrer Bestellung 4500112944 vom ..."). Finde sie trotzdem.
- Findungen verstecken sich häufig im Fließtext oder in Fußnoten, NICHT nur in Tabellen: Preisänderungen ("der Preis beträgt nun 47,20 EUR"), nicht bestätigte Termine ("der Wunschtermin kann leider nicht gehalten werden"), Teillieferungen, Zuschläge. Erfasse diese im passenden Feld (notes / unit_price / global_notes).
- Kalenderwochen ("KW 31") in das Freitagsdatum dieser Woche umrechnen und die Original-Angabe in delivery_date_note vermerken.
- Datumsangaben als ISO yyyy-mm-dd zurückgeben.
- Wenn das Dokument KEINE Auftragsbestätigung ist (Rechnung, Lieferschein, Angebot, unbekannt) oder keine Bestellnummer erkennbar ist: is_order_confirmation = false setzen.
- Erfinde nichts. Fehlende Felder bleiben null.`;
