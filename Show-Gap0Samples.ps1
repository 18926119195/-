$obj = Get-Content 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\adjacency-analysis-result.json' -Raw | ConvertFrom-Json
$gap0 = @($obj.strictCandidates | Where-Object { $_.connector -eq '' })
Write-Output ("gap0 (empty connector) count: " + $gap0.Count)
$i = 0
foreach ($p in $gap0) {
    if ($i -ge 40) { break }
    Write-Output ("  " + ($i + 1) + ". [" + $p.leftSurface + "][" + $p.rightSurface + "]")
    $i++
}
