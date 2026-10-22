# DSE ICT Past-Paper Question Bank

Data files for the DSE ICT Past Paper Drilling Platform. The platform loads
these JSON files at runtime, so updating the bank = updating these files.

- `question-bank.json` — verified past-paper questions with official marking
  schemes (built by `build_db.py` from per-paper JSON extractions).
- `faq.json` — common questions paired with standard marking-scheme keywords,
  mined from the same official schemes.

Do not edit these files by hand; they are generated.
