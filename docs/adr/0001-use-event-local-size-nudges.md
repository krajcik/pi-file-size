# Use event-local size nudges

The package will observe attributable file mutations and append a short, non-blocking size nudge only to a triggering tool result. It will not add permanent prompt instructions, block mutations, or expose an LLM tool: silent work must have no model-context overhead, while warnings must remain adjacent to the change that caused them.
