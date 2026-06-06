// Placeholder table-order + timeline data for TableOrderPage until the POS
// integration lands. Isolated here so swapping in the real API is one file.

export const MOCK_TABLE_ORDERS = {
  T1: [
    { name: "Burrata Caprese", notes: "Heirloom tomato, basil oil", qty: 1, price: 22, status: "served" },
    { name: "Aperol Spritz", notes: "Extra orange", qty: 2, price: 16, status: "served" },
    { name: "Tiramisu", notes: "Share plate", qty: 1, price: 14, status: "pending" },
    { name: "Espresso", notes: "Decaf", qty: 1, price: 5, status: "pending" },
  ],
  T2: [
    { name: "Wagyu Burger", notes: "Medium Rare, No Onions", qty: 2, price: 28, status: "fired" },
    { name: "Truffle Fries", notes: "Extra Aioli", qty: 1, price: 14, status: "fired" },
    { name: "Red Wine Glass", notes: "Pinot Noir", qty: 2, price: 16, status: "served" },
  ],
  T3: [
    { name: "Beef Carpaccio", notes: "Capers, parmesan", qty: 1, price: 26, status: "served" },
    { name: "Lamb Ragu Pappardelle", notes: "House-made pasta", qty: 2, price: 32, status: "fired" },
    { name: "Pan-Seared Salmon", notes: "Skin on, lemon butter", qty: 1, price: 38, status: "fired" },
    { name: "Sparkling Water (1L)", notes: null, qty: 1, price: 9, status: "served" },
    { name: "Crème Brûlée", notes: "Vanilla bean", qty: 2, price: 13, status: "pending" },
  ],
  T4: [
    { name: "Bread Basket", notes: "Sourdough + cultured butter", qty: 1, price: 8, status: "served" },
    { name: "Duck Confit", notes: "Cherry jus", qty: 1, price: 42, status: "served" },
    { name: "Glass of Shiraz", notes: "Barossa Valley", qty: 1, price: 15, status: "served" },
    { name: "Affogato", notes: null, qty: 1, price: 12, status: "pending" },
  ],
  T5: [
    { name: "Burrata Caprese", notes: "Heirloom tomato", qty: 2, price: 22, status: "served" },
    { name: "Bistecca alla Fiorentina", notes: "Rare, share for 2", qty: 1, price: 96, status: "fired" },
    { name: "Truffle Risotto", notes: "Black truffle shavings", qty: 2, price: 36, status: "fired" },
    { name: "Bottle of Barolo", notes: "2018 vintage", qty: 1, price: 110, status: "served" },
    { name: "Tiramisu", notes: "Birthday — add candle", qty: 3, price: 14, status: "pending" },
  ],
  T6: [
    { name: "Caesar Salad", notes: "Anchovy on side", qty: 2, price: 18, status: "served" },
    { name: "Wagyu Sirloin", notes: "Medium rare, peppercorn jus", qty: 2, price: 68, status: "fired" },
    { name: "Sparkling Water (1L)", notes: null, qty: 1, price: 9, status: "served" },
    { name: "Crème Brûlée", notes: "Two spoons", qty: 2, price: 13, status: "pending" },
  ],
  T7: [
    { name: "Bread Basket", notes: "Gluten-free option", qty: 2, price: 8, status: "served" },
    { name: "Beef Carpaccio", notes: "Capers, parmesan", qty: 2, price: 26, status: "served" },
    { name: "Pan-Seared Salmon", notes: "One without lemon", qty: 3, price: 38, status: "fired" },
    { name: "Lamb Ragu Pappardelle", notes: "Extra cheese", qty: 2, price: 32, status: "fired" },
    { name: "Bottle of Pinot Grigio", notes: "Well chilled", qty: 2, price: 64, status: "served" },
  ],
};

export const MOCK_TABLE_TIMELINE = {
  T1: [
    { time: "12:55 PM", source: "AI VOICE", text: "Bella took booking for lunch at 1:00 PM (2 guests)." },
    { time: "1:04 PM", source: "KITCHEN", text: "Burrata Caprese fired, prep time ~6 min." },
    { time: "1:10 PM", source: "FLOOR", text: "Aperol Spritz delivered to table." },
  ],
  T2: [
    { time: "12:40 PM", source: "KITCHEN", text: "Mains ordered: 2x Wagyu Burger, 1x Truffle Fries. Sent to KDS." },
    { time: "12:34 PM", source: "AI VOICE", text: "Drinks ordered: 2x Red Wine Glass. Processed automatically." },
    { time: "12:30 PM", source: "AI VOICE", text: "Reservation confirmed by AI VOICE for 2 people. Special request: Birthday celebration." },
  ],
  T3: [
    { time: "7:18 PM", source: "AI VOICE", text: "Anniversary booking confirmed for 7:30 PM, party of 4." },
    { time: "7:38 PM", source: "KITCHEN", text: "Carpaccio plated, pappardelle 8 min out." },
  ],
  T4: [
    { time: "1:05 PM", source: "AI VOICE", text: "Solo booking taken, business-lunch tag added." },
    { time: "1:22 PM", source: "FLOOR", text: "Duck Confit delivered." },
  ],
  T5: [
    { time: "6:42 PM", source: "AI VOICE", text: "Birthday party of 6 confirmed for 7:30 PM. Cake to follow." },
    { time: "7:38 PM", source: "KITCHEN", text: "Bistecca on the grill — 12 min." },
    { time: "7:44 PM", source: "FLOOR", text: "Barolo opened and decanting." },
  ],
  T6: [
    { time: "7:10 PM", source: "AI VOICE", text: "Corporate booking confirmed for 7:30 PM, 4 guests." },
    { time: "7:35 PM", source: "KITCHEN", text: "Wagyu Sirloin x2 fired to medium-rare." },
  ],
  T7: [
    { time: "5:30 PM", source: "AI VOICE", text: "Group of 10 confirmed for 8:00 PM pre-theatre." },
    { time: "8:08 PM", source: "KITCHEN", text: "Mains fired in two waves to keep timing." },
    { time: "8:12 PM", source: "FLOOR", text: "Wine service complete — 2 bottles Pinot Grigio poured." },
  ],
};

