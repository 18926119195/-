$ErrorActionPreference = 'Stop'

$ResultPath = 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\adjacency-analysis-result.json'
$obj = Get-Content $ResultPath -Raw | ConvertFrom-Json
$all = @($obj.strictCandidates)
Write-Output ("========== Merge-necessity breakdown (gap<=1 strict candidates) ==========")
Write-Output ("Total strict candidates: {0}" -f $all.Count)

# Junk type A: left surface ends with newline -> chapter/section title cut off by a following
# unrelated noun. Not a real compound-noun boundary.
$titleBreak = @($all | Where-Object { $_.leftSurface -match "`n$" })

# Junk type B: right surface starts with comma (extraction absorbed the comma into the noun
# surface itself) -> the two nouns are on different sides of a comma, i.e. sentence-level
# adjacency, not a compound noun.
$commaLed = @($all | Where-Object { $_.rightSurface.TrimStart() -match '^,' })

# Junk type C: right surface is a short lowercase fragment (<=10 chars, starts lowercase) that
# is not preceded by type A/B -> likely OCR word-break remnant (e.g. "-ciation").
$fragmentLike = @($all | Where-Object {
    $_.rightSurface.Length -le 10 -and $_.rightSurface -cmatch '^[a-z]' -and
    ($_.leftSurface -notmatch "`n$") -and ($_.rightSurface.TrimStart() -notmatch '^,')
})

$junkKeys = New-Object System.Collections.Generic.HashSet[string]
foreach ($p in $titleBreak) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }
foreach ($p in $commaLed) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }
foreach ($p in $fragmentLike) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }

$clean = @($all | Where-Object { -not $junkKeys.Contains("$($_.leftId)|$($_.rightId)|$($_.leftEnd)") })

Write-Output ("`n-- Junk breakdown --")
Write-Output ("Type A (title cut off by newline): {0}" -f $titleBreak.Count)
Write-Output ("Type B (comma-led right surface, sentence-level adjacency not compound noun): {0}" -f $commaLed.Count)
Write-Output ("Type C (OCR word-break fragment): {0}" -f $fragmentLike.Count)
Write-Output ("Total junk (deduped): {0} ({1:P1} of strict candidates)" -f ($all.Count - $clean.Count), (($all.Count - $clean.Count) / $all.Count))
Write-Output ("Remaining plausible real candidates: {0} ({1:P1} of strict candidates)" -f $clean.Count, ($clean.Count / $all.Count))

Write-Output "`n-- Sample of remaining plausible candidates (40) --"
$i = 0
foreach ($p in $clean) {
    if ($i -ge 40) { break }
    Write-Output ("  {0}. [{1}][{2}]" -f ($i + 1), $p.leftSurface, $p.rightSurface)
    $i++
}

Write-Output "`n========== Cost comparison =========="
$batchSize = 10
Write-Output ("If LLM merge review runs on ALL adjacency pairs (gap 0-3, as designed): 9314 pairs -> {0} requests" -f [math]::Ceiling(9314 / $batchSize))
Write-Output ("If LLM merge review runs on strict candidates (gap<=1, punctuation excluded): {0} pairs -> {1} requests" -f $all.Count, [math]::Ceiling($all.Count / $batchSize))
Write-Output ("If LLM merge review runs ONLY on remaining plausible candidates (after junk filter): {0} pairs -> {1} requests" -f $clean.Count, [math]::Ceiling($clean.Count / $batchSize))
