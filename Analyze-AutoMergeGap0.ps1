$ErrorActionPreference = 'Stop'

$ResultPath = 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\adjacency-analysis-result.json'
$obj = Get-Content $ResultPath -Raw | ConvertFrom-Json
$all = @($obj.strictCandidates)
Write-Output ("DEBUG all.Count: {0}" -f $all.Count)

$gap0List = @()
foreach ($p in $all) {
    $diff = $p.rightStart - $p.leftEnd
    if ($diff -eq 0) { $gap0List += $p }
}
$gap0 = $gap0List
Write-Output ("========== gap=0 pure adjacency (no offset gap at all) ==========")
Write-Output ("Total gap=0 pairs: {0}" -f $gap0.Count)

$titleBreak = @($gap0 | Where-Object { $_.leftSurface -match "`n$" })
$commaLed = @($gap0 | Where-Object { $_.rightSurface.TrimStart() -match '^,' })
$fragmentLike = @($gap0 | Where-Object {
    $_.rightSurface.Length -le 10 -and $_.rightSurface -cmatch '^[a-z]' -and
    ($_.leftSurface -notmatch "`n$") -and ($_.rightSurface.TrimStart() -notmatch '^,')
})
$punctInSurface = @($gap0 | Where-Object {
    $_.leftSurface -match '[.!?;:*/\[\]()]' -or $_.rightSurface -match '[.!?;:*/\[\]()]'
})

$junkKeys = New-Object System.Collections.Generic.HashSet[string]
foreach ($p in $titleBreak) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }
foreach ($p in $commaLed) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }
foreach ($p in $fragmentLike) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }
foreach ($p in $punctInSurface) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }

$clean = @($gap0 | Where-Object { -not $junkKeys.Contains("$($_.leftId)|$($_.rightId)|$($_.leftEnd)") })

Write-Output ("`n-- Noise breakdown --")
Write-Output ("Title cut off by newline: {0}" -f $titleBreak.Count)
Write-Output ("Comma-led right surface: {0}" -f $commaLed.Count)
Write-Output ("OCR word-break fragment: {0}" -f $fragmentLike.Count)
Write-Output ("Contains stray punctuation: {0}" -f $punctInSurface.Count)
Write-Output ("Total noise (deduped): {0} ({1:P1})" -f ($gap0.Count - $clean.Count), (($gap0.Count - $clean.Count) / $gap0.Count))
Write-Output ("Remaining after noise filter: {0} ({1:P1})" -f $clean.Count, ($clean.Count / $gap0.Count))

Write-Output "`n-- All remaining candidates after noise filter --"
$i = 0
foreach ($p in $clean) {
    $i++
    Write-Output ("  {0}. [{1}][{2}]" -f $i, $p.leftSurface, $p.rightSurface)
}

$grammaticallyPlausible = @($clean | Where-Object {
    $_.rightSurface -cmatch '^[a-z]' -and
    $_.leftSurface.Length -ge 2 -and $_.leftSurface.Length -le 30 -and
    $_.rightSurface.Length -ge 2 -and $_.rightSurface.Length -le 30 -and
    $_.leftSurface -notmatch '\d' -and $_.rightSurface -notmatch '\d' -and
    $_.leftSurface -notmatch "`n" -and $_.rightSurface -notmatch "`n"
})
Write-Output ("`n-- Grammatically plausible subset --")
Write-Output ("Count: {0} / {1} clean candidates" -f $grammaticallyPlausible.Count, $clean.Count)
Write-Output ("Count: {0} / {1} total gap=0 candidates ({2:P1})" -f $grammaticallyPlausible.Count, $gap0.Count, ($grammaticallyPlausible.Count / $gap0.Count))
foreach ($p in $grammaticallyPlausible) {
    Write-Output ("  [{0}][{1}]" -f $p.leftSurface, $p.rightSurface)
}
