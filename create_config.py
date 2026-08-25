import pandas as pd
import json

# Read the CSV
df = pd.read_csv("all_1bn_MarketCap.csv")

# Drop completely empty rows (the ones that appear at the end of the file)
df = df.dropna(how="all")

# Drop rows that have no Symbol (safety)
df = df.dropna(subset=["Symbol"])

# Clean Industry column: replace NaN / empty strings with a placeholder
df["Industry"] = df["Industry"].fillna("Unknown / Blank").str.strip()
df.loc[df["Industry"] == "", "Industry"] = "Unknown / Blank"

# Group tickers by Industry
grouped = (
    df.groupby("Industry")["Symbol"]
    .apply(list)
    .to_dict()
)

# Optional: also keep full company info under each industry
# (uncomment the block below if you want richer output)
"""
grouped = {}
for industry, group in df.groupby("Industry"):
    grouped[industry] = group[["Symbol", "Name", "Market Cap", "Sector"]].to_dict(orient="records")
"""

# Write JSON
output_path = "tickers_by_industry.json"
with open(output_path, "w", encoding="utf-8") as f:
    json.dump(grouped, f, indent=2, ensure_ascii=False)

print(f"Created {output_path}")
print(f"Total industries: {len(grouped)}")
print(f"Total tickers: {sum(len(v) for v in grouped.values())}")