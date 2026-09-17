$obj = Get-Content 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\adjacency-analysis-result.json' -Raw | ConvertFrom-Json
$all = @($obj.strictCandidates)
Write-Output ("total: " + $all.Count)
$diffs = $all | ForEach-Object { $_.rightStart - $_.leftEnd }
$diffs | Group-Object | Sort-Object Name | ForEach-Object { Write-Output ($_.Name + ": " + $_.Count) }
