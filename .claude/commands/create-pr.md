______________________________________________________________________

description: "Create a pull request from current branch or staged changes"
allowed-tools:

- Bash(./.claude/branch-name.sh)
- Bash(just \*)
- Bash(git \*)
- Bash(gh \*)

______________________________________________________________________

# Create Pull Request

This command:

- optionally creates a branch if we are on main/master branch
- runs git add . — all files should be staged for commit.
- ensures we have latest dependencies (i.e `just install` or `just sync`) or for Ruby apps, check file `.ruby-version` and if check if `rbenv versions` shows this version, and if not instructions for installing a Ruby process are very simple: run `~/.bashmatic/bin/ruby-install $(cat .ruby-version)`
- then this command validates that all the checks and linters are passing. It generally executes this repo's overall check. Sometimes it's `just check-all`, sometimes `just ci`, and sometimes it's `just test`. Or, for ruby application, `bundle exec rspec --format documentation`.
- after that it
  - checks the `git diff --cached` for the staged files and figure out what this commit is about
  - figure out if all staged files belong to the same logical PR or it should be multiple
  - for each it creates a new branch and performs a commit, by providing a proper PR title and PR body that's detailed and concise.
  - pushes this PR to the origin updating its title and body using `gh pr` tool.

## Details

### Branch Name

First you must check if the current branch is `main` or not. If the branch is not `main`, we are OK, and we can skip to the next section.

If, however, the current branch is `main` and the user has some changes (staged or unstaged), you must first create a new branch for this pull request.

To do so, you must first invoke the script provided in this directory named `branch-name.sh` and capture it's STDOUT. The script interacts with the user by means of STDIN and STDERR, and the branch name is the only data printed to STDOUT. Once you capture the branch name, create it with `git checkout -b <branch-name>`.

### Staged Files Only

There should only be staged for commit files, no locally modified files. If there are they need to be safely stashed. Once we decide this we validate this repo by running it's validating command, eg `just ci`, or `lefthook run pre-commit` or `just check-all`.

If something doesn't pass, fix the issue particularly if its in the test, and proceed non-interactively unless you are modifying business logic.

Once all of the the checks are passing, we can once again perform `git add` our changes, and can skip to the section further below called "Committing Changes and Creating the PR".

#### There are Staged and Unstaged or Untracked Files

(Very unlikely, yet possible scenario)

If there are unstaged or untracked changes in the workspace in addition to staged, you must ask the user if these files are to be stashed, all of them added to staged, each file is added to staged or not interactively, or discarded.

Present the choices as a menu that user picks from.

If the user responds with:

- Stashed, you must perform a series of git commands to stash the unstaged/untracked files for later recall:
  1. `git commit -m 'WIP: staged changes' --no-verify` — commit the staged changes temporarily
  1. `git stash push --include-untracked` — stash the remaining unstaged changes
  1. `git reset --soft HEAD^` — undo the temporary commit.
  1. `git add .` — to stage the previously staged for commit files

Now the situation is identical to "1. Staged Files Only", so you follow those instructions above.

After the PR is created and branch is pushed (See "Committing Changes and Creating the PR" section) ask the user if they want to restore the unstaged changes, and if they confirm, run `git stash apply`.

#### There are Unstaged and/or Untracked files only

(Very unlikely, yet possible scenario)

In this case, you ask the user if they want to `git add` all of the files, or just some of the files, and unless they say "all of the files", you stop and wait for them to perform this action on their own, before you continue with the PR. Let the user know to use another terminal to choose which files to stage and which not.

After that you will be in the situation described by the section "2. There are Staged and Unstaged or Untracked Files", and you continue accordingly.

### Committing Changes and Creating the PR

Once we are on the branch, and either there are only changes staged for commit or NO changes at all (so we'll be creating the PR from the branch).

DO NOT REBASE FROM MAIN.

But ensure that you performed `git fetch`.

### Resolving Conflicts

If there are conflicts, you inform the user and ask them if they need help resolving conflicts and if you know how to do that, you help the user to do so. Otherwise you wait until the user resolves conflicts in another terminal and returns when the files are staged for commit and conflicts are resolved.

## Committing Currently Staged Changes

At this point, you should either a clean branch with all changes committed, or some changes staged for commit.

If there are changes staged for commit, you must perform `git diff --cached`, and summarize those changes in the markdown format in a temporary file we'll call <tempfile> (preferably under /tmp folder), and create a short title for the commit.

Then we commit with `git commit -m "<title>" -F "<tempfile>"`, and push the changes `git push -u origin`.

### Creating the PR

Try to perform all of these steps automatically without interactive confirmations.

This is the final step. You are to use command `gh` (which stands for `github`).

In order to create a PR we must NOT be on the `main` branch, we must have all changes pushed to the origin and we must have no locally untracked or modified files.

The next step is describing the PR.

You are going to perform the diff of the current branch with the remote `main` branch using `git diff origin/main...HEAD`, and analyze it. You will create a markdown file that we'll refer to <pr-description> preferably in the `/tmp` folder, that describes the changes of this PR precisely, professionally, without any emojis. It should have the top header title that we'll refer to <pr-title>, (with a single '#' in markdown) that will also be the name of the PR. It should have the sections such as Summary (a short abstract-type description, no more than a few paragraphs) Description (if necessary, a more detailed description), Motivation, Testing, Backwards Compatibility, Scalability & Performance Impact, and Code Quality Analysis.

Once completed analysis and summarizing of this change, you will invoke the command `gh pr create -a @me -B main -F "<pr-description>" -t "<pr-title>"`.

If the command responds with an error such as Github Token authorization is insufficient, you are to save the PR description in the file at the root of the project called `PR.md` and report this to the user. Also print the URL required to create the PR on the web by clicking on the URL.

If you were able to create the PR with the `gh pr create` command, then open the web page to it anyway. Get the PR ID with `gh pr list | grep "<pr-title>" | awk '{print $1}'`
