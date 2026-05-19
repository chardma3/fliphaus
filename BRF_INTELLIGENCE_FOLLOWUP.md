# BRF Intelligence Follow-up

This note exists so we do not lose track of the important caveat from the first BRF intelligence build.

## Current status

The first BRF intelligence / renovation-arbitrage layer is implemented and pushed.

It can now calculate, for each active listing:

- BRF name
- build year
- stambyte status/year, when known
- BRF debt per m², when known
- BRF debt/avgift risk
- renovated vs unrenovated sold-property comparison
- same-BRF or area-level evidence scope
- estimated renovation uplift per m²
- estimated total uplift for the current flat
- confidence level

## Important caveat

Existing sold listings may not yet have enough enriched data for the same-BRF comparison to work well.

Older sold records may be missing:

- BRF name
- all listing images
- renovation score
- condition label: renovated / partly_renovated / unrenovated / unknown
- stambyte clues
- build year

Because of this, the first few BRF intelligence results may show `insufficient` or only `area-level` evidence until `/api/scrape-sold` has refreshed and enriched more sold listings.

## Regular validation checklist

Run this check after deploying the feature and periodically after sold-data refreshes.

1. Run or trigger the sold scrape:

   - Open `/api/scrape-sold` in the deployed app, or run the equivalent server route locally.

2. Check sold data quality via `/api/sold/stats`:

   Confirm that sold listings increasingly include:

   - `brfName`
   - multiple `images`
   - `renovationScore`
   - `conditionLabel`
   - `soldPriceSqm`

3. Check active listings via `/api/listings`:

   Confirm that each listing includes `brfIntelligence` with:

   - `brf`
   - `renovationArbitrage`
   - `scope`
   - `confidence`
   - `estimatedUpliftPerSqm`, when enough comps exist
   - `estimatedUpliftTotal`, when enough comps and size exist

4. Look specifically for higher-value cases:

   The best output is:

   - `scope: "same_brf"`
   - at least one renovated sold comp
   - at least one unrenovated sold comp
   - non-null `estimatedUpliftPerSqm`
   - confidence medium or high

5. If most results remain `insufficient`, inspect why:

   - Sold pages may not expose BRF names in the current Hemnet page data.
   - Sold detail image extraction may need adjustment.
   - The AI renovation analysis may not be running for sold listings because images are missing.
   - We may need address/coordinate-based matching as a fallback when BRF name is unavailable.

## Next likely improvements

1. Add address/coordinate matching when BRF name is missing.
2. Add a small admin/debug page showing BRF intelligence coverage:
   - % of sold listings with BRF name
   - % with condition label
   - % with renovation score
   - number of same-BRF matches per active listing
3. Add a scheduled sold-data refresh if the deployment supports it.
4. Add manual override/editing for sold listing condition labels, because AI classification can be wrong.
5. Add source/debug fields explaining which sold listings were used as comparables.

## Related commit

Initial implementation commit:

`78c7bc1 Add BRF renovation arbitrage intelligence`
