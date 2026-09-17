$ErrorActionPreference = 'Stop'
$obj = Get-Content 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\adjacency-analysis-result.json' -Raw | ConvertFrom-Json
$gap0 = @($obj.strictCandidates | Where-Object { $_.connector -eq '' })
Write-Output ("gap0 total: " + $gap0.Count)

# 右词surface以标点开头 => 提取误差（真实文本里其实是有分隔符的，只是被错误吸收进了surface字段）
$rightStartsWithPunct = @($gap0 | Where-Object { $_.rightSurface -match '^[,;:.!?)\]}"''-]' })
Write-Output ("right surface starts with punctuation (extraction artifact): " + $rightStartsWithPunct.Count)

$leftEndsOk = @($gap0 | Where-Object { $_.rightSurface -notmatch '^[,;:.!?)\]}"''-]' })
Write-Output ("genuinely clean gap0 (no punctuation artifact): " + $leftEndsOk.Count)

Write-Output "`nSamples of genuinely clean gap0 pairs (first 30):"
$i = 0
foreach ($p in $leftEndsOk) {
    if ($i -ge 30) { break }
    Write-Output ("  " + ($i+1) + ". [" + $p.leftSurface + "][" + $p.rightSurface + "]")
    $i++
}
