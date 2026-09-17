$ErrorActionPreference = 'Stop'

$ResultPath = 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\adjacency-analysis-result.json'
$obj = Get-Content $ResultPath -Raw | ConvertFrom-Json
$all = @($obj.strictCandidates)

# gap=1 且 connector 恰好是单个空格的子集：这是最像"复合名词候选"的一类
# (leftEnd 到 rightStart 之间只隔了一个空格字符)
$spaceGap1 = @($all | Where-Object { ($_.rightStart - $_.leftEnd) -eq 1 })
Write-Output ("gap=1 candidates within strict set: {0}" -f $spaceGap1.Count)

# 对这个子集做同样的junk过滤
$titleBreak = @($spaceGap1 | Where-Object { $_.leftSurface -match "`n$" })
$commaLed = @($spaceGap1 | Where-Object { $_.rightSurface.TrimStart() -match '^,' })
$fragmentLike = @($spaceGap1 | Where-Object {
    $_.rightSurface.Length -le 10 -and $_.rightSurface -cmatch '^[a-z]' -and
    ($_.leftSurface -notmatch "`n$") -and ($_.rightSurface.TrimStart() -notmatch '^,')
})

$junkKeys = New-Object System.Collections.Generic.HashSet[string]
foreach ($p in $titleBreak) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }
foreach ($p in $commaLed) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }
foreach ($p in $fragmentLike) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }

$cleanSpaceGap1 = @($spaceGap1 | Where-Object { -not $junkKeys.Contains("$($_.leftId)|$($_.rightId)|$($_.leftEnd)") })
Write-Output ("After junk filter, plausible real single-space-adjacent candidates: {0} ({1:P1} of gap=1 space subset)" -f $cleanSpaceGap1.Count, ($cleanSpaceGap1.Count / $spaceGap1.Count))

Write-Output "`nSample of 40 plausible single-space candidates:"
$i = 0
foreach ($p in $cleanSpaceGap1) {
    if ($i -ge 40) { break }
    Write-Output ("  {0}. [{1}] [{2}]" -f ($i + 1), $p.leftSurface, $p.rightSurface)
    $i++
}
