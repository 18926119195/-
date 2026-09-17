$ErrorActionPreference = 'Stop'

$ResultPath = 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\adjacency-analysis-result.json'
$obj = Get-Content $ResultPath -Raw | ConvertFrom-Json
$all = @($obj.strictCandidates)

# 同样的junk过滤（title-break / comma-led / OCR fragment）
$titleBreak = @($all | Where-Object { $_.leftSurface -match "`n$" })
$commaLed = @($all | Where-Object { $_.rightSurface.TrimStart() -match '^,' })
$fragmentLike = @($all | Where-Object {
    $_.rightSurface.Length -le 10 -and $_.rightSurface -cmatch '^[a-z]' -and
    ($_.leftSurface -notmatch "`n$") -and ($_.rightSurface.TrimStart() -notmatch '^,')
})
$junkKeys = New-Object System.Collections.Generic.HashSet[string]
foreach ($p in $titleBreak) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }
foreach ($p in $commaLed) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }
foreach ($p in $fragmentLike) { [void]$junkKeys.Add("$($p.leftId)|$($p.rightId)|$($p.leftEnd)") }
$clean = @($all | Where-Object { -not $junkKeys.Contains("$($_.leftId)|$($_.rightId)|$($_.leftEnd)") })

Write-Output ("Clean candidate pairs (post junk filter): {0}" -f $clean.Count)

# 按 (leftSurface, rightSurface) 去重，统计真正不同的“词对类型”有多少
$pairGroups = $clean | Group-Object -Property { "$($_.leftSurface)`u{2192}$($_.rightSurface)" }
Write-Output ("Unique (leftSurface -> rightSurface) pair types: {0}" -f $pairGroups.Count)
Write-Output ("Average occurrences per unique pair type: {0:N2}" -f ($clean.Count / $pairGroups.Count))

$topRepeated = $pairGroups | Sort-Object Count -Descending | Select-Object -First 20
Write-Output "`nTop 20 most-repeated pair types (same pair recurring across the book):"
$i = 0
foreach ($g in $topRepeated) {
    $i++
    Write-Output ("  {0}. x{1}  {2}" -f $i, $g.Count, $g.Name)
}

# 按 leftSurface 去重后的独立中心词数量：如果只对 unique left-surface 或 unique pair 各跑一次 LLM，
# 而不是对每个 offset 出现都跑，成本会显著降低
$uniqueLeftSurfaces = ($clean | Select-Object -ExpandProperty leftSurface -Unique).Count
Write-Output ("`nUnique left-surface values among clean candidates: {0}" -f $uniqueLeftSurfaces)


$ResultPath = 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\adjacency-analysis-result.json'
$obj = Get-Content $ResultPath -Raw | ConvertFrom-Json
$all = @($obj.strictCandidates)

# 关键判断点：这些"相邻名词对"里，有多少是同一对(leftSurface+rightSurface)反复出现？
# 如果是高频重复对（如 "Univers"+"incorporels" 出现6次），说明这是文本里稳定的复合名词/术语，
# 相关词命中的LLM和拓扑链LLM在正常抽取/召回时本来就会反复看到这个词组合，
# 完全可以在那两个环节里被当作固定搭配处理，不需要专门起一条合并审查流水线。
$groups = $all | Group-Object -Property { "$($_.leftSurface)||$($_.rightSurface)" }
$sorted = $groups | Sort-Object Count -Descending

Write-Output ("Total strict candidates: {0}" -f $all.Count)
Write-Output ("Unique (leftSurface,rightSurface) pairs: {0}" -f $groups.Count)
Write-Output ("`nTop 30 most frequent repeated pairs (candidates for genuinely stable compound terms):")
$i = 0
foreach ($g in $sorted) {
    if ($i -ge 30) { break }
    if ($g.Count -lt 2) { break }
    Write-Output ("  {0}. x{1}  {2}" -f ($i+1), $g.Count, $g.Name)
    $i++
}

$repeatedCount = ($sorted | Where-Object { $_.Count -ge 2 }).Count
$repeatedTotal = ($sorted | Where-Object { $_.Count -ge 2 } | Measure-Object -Property Count -Sum).Sum
Write-Output ("`nPairs appearing >=2 times: {0} unique pairs, covering {1} of the {2} total candidate instances" -f $repeatedCount, $repeatedTotal, $all.Count)
Write-Output ("Pairs appearing only once: {0} unique pairs / {0} instances" -f ($groups.Count - $repeatedCount))
