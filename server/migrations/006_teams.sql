-- 006_teams.sql - partners play.
--
-- A team is a LABEL ON A SEAT, not a table. Two people throwing into one side
-- of a match is the whole of it, and modelling that as a `teams` table with its
-- own identity would buy nothing: teams do not persist between matches, they
-- have no name, and nothing is ever looked up by one.
--
-- NULL means singles, and that is the honest representation rather than a
-- default of 0. Every match already in this database was played by individuals,
-- so they read back as singles without being touched - which is what makes this
-- migration additive in fact and not only in form.
ALTER TABLE match_players ADD COLUMN team INTEGER;

-- Who won, when who-won is a pair.
--
-- winner_seat stays exactly as it was and keeps its meaning: the seat that won
-- a singles leg or match. It is NULL in a partners game, because no single seat
-- won one. The two columns are deliberately not collapsed into a single
-- "winner" - a reader would then have to know which kind of index it was
-- holding, which is precisely the confusion the seat/side split exists to
-- prevent (see docs/team-play.md 3a).
--
-- On legs it also carries a case that has no seat at all even in principle:
-- reaching zero while frozen hands the leg to the opposition without anybody
-- checking out, so winner_team is set while winner_seat is NULL and the visit
-- that reached zero is correctly not marked as a checkout.
ALTER TABLE matches ADD COLUMN winner_team INTEGER;
ALTER TABLE legs ADD COLUMN winner_team INTEGER;
