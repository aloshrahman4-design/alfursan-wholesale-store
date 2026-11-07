const CATEGORY_WORDS = {
  "أحذية": ["حذاء", "احذية", "أحذية", "قندرة", "قندره", "بوت", "كعب", "سنيكرز"],
  "شحاطات": ["شحاطة", "شحاطه", "شحاطات", "سليبر", "سليبرات", "خف"],
  "حقائب": ["حقيبة", "حقيبه", "حقائب", "جنطة", "جنطه", "شنطة", "شنطه"],
};

function smartParse(caption) {
  const rawLines = (caption || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const result = { name: "منتج جديد", description: "", category: "" };

  if (rawLines[0]) result.name = rawLines[0].slice(0, 90);
  result.description = rawLines.slice(1).join(" · ").slice(0, 400);

  for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
    if (words.some((w) => (caption || "").includes(w))) { result.category = cat; break; }
  }
  if (!result.category) result.category = "منوعات";

  return result;
}

module.exports = { smartParse };
