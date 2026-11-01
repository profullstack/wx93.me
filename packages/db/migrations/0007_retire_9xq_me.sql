-- 9xq.me is no longer a short-link host. Existing links keep their codes on wx93.me.
update links
set short_host = null
where lower(short_host) = '9xq.me';
