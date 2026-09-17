$ErrorActionPreference = 'Stop'
$obj = Get-Content 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\adjacency-analysis-result.json' -Raw | ConvertFrom-Json
$gap0 = @($obj.strictCandidates | Where-Object { $_.connector -eq '' })

# 更严格的垃圾过滤：左词以标题式换行符结尾（说明是章节标题被切断，不是相邻名词短语），
# 或右词以小写残片/续接片段开头（OCR断词，如 "ciation" 是 "-ciation" 的残片）
$titleBreak = @($gap0 | Where-Object { $_.leftSurface -match "`n$" })
$fragmentLike = @($gap0 | Where-Object { $_.rightSurface.Length -le 10 -and $_.rightSurface -cmatch '^[a-z]' -and $_.leftSurface -notmatch "`n$" })

Write-Output ("gap0 total: " + $gap0.Count)
Write-Output ("title-break artifacts (left ends with newline, i.e. chapter title cut short): " + $titleBreak.Count)
Write-Output ("fragment-like right surface (lowercase start, <=10 chars, likely OCR word-break remnant): " + $fragmentLike.Count)

$realCandidates = @($gap0 | Where-Object {
    ($_.leftSurface -notmatch "`n$") -and
    -not ($_.rightSurface.Length -le 10 -and $_.rightSurface -cmatch '^[a-z]')
})
Write-Output ("remaining after filtering both junk types: " + $realCandidates.Count)
Write-Output "`nSamples of remaining candidates:"
$i = 0
foreach ($p in $realCandidates) {
    if ($i -ge 40) { break }
    Write-Output ("  " + ($i+1) + ". [" + $p.leftSurface + "][" + $p.rightSurface + "]")
    $i++
}
