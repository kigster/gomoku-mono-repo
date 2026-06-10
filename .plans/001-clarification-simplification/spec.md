# Game online behavior and opportunities

## Play with AI | Play with one of the N Available Random Humans

If you choose "Humans" the following

1. When Gomoku first loads, we show a modal that says: [ 53 People Online, 23 Are playing ] — these numbers must be real time pushed via the websocket.
1. You see that at the top of the window in the smaller model box that has two buttons: Play with AI | Play with a Elo-Matched Human
1. If they choose playe with Human, we select the closest non-playing human by Elo score, and both of them get "Ready to Start?" message, except the person who chose the random person gets "You matched with @john (1453). Ready to start?"
1. While the other player gets "@bob (1534) would like to play a game with you. Say Yes? And if so, you'd prefer:"
   1. if both players say yes, the see the following three buttons below on the same small window appear.
   1. Small Buttons: [ Start The Game as Black ] | [ Start The Game As White ] | [ Don't Care ]
   1. Now here how the logic goes: if the users picked compatible answers (don't care works with either), and there is only one that satisfies — use that one. If there are more than one answer that satisfies this configuration, choose one at random.
   1. If the players both want the same thing, choose that one thing at random (and show a message to the other one — rolled the dice, sorry they won).
   1. And the game begins

> [!CAUTION]
>
> We must switch to websocket instead of pulling of the status for all of the events that must be broadcast and must update more than one person's screen. Websockets will be used to send the full JSON response of the game with the move in it (the fastest) as well as for 1-1 chat between the players ONLY dureing their game play. Post game play, the chat window will say: "Great game you two! Closing the chat in 3...2...1....." (closed).

1. Only the move POST remains an HTTP call, and all the login/registration remains as is.

1. WebSocket stays open whether or not the game is being played. If it's not, it's used to receive invitations to play and pass the decision back.

1. Below that, there should be a long buttons, vertically stacked, taking up 75% of the width:

   1. I'd like to play another human with a higher Elo score than me"
   1. I'd like to play another human with a lower Elo score than me"
   1. I'd like to play vs a computer on Easy Mode
   1. I'd like to play vs a computer on Intermediate Mode
   1. I'd like to play vs a computer on Hard Mode
   1. I'd like to play vs a computer on Hardest Mode (Premium Game: $1 — Play for Free during Beta Testing)

1. Human vs Human games have a checkbox at the beginning. If one of them checks it, the game becomes timed: at most 15 seconds to think of a move, the entire game is a draw at 5 minutes unless someone won).

1. If neither of the players checks the "Timed Game", then the only the game has a 30 minute expiration timeout.

1. All timeouts should be prominantly displayed at the very top of the board model, next to whose turn it is.=

1. The frontend must recognize when a player wins, and perform an animation that lifts the winning 5 stones off the table, and puts them back on the table with some diamond shine eminating from them. Until they press "Back" the winning 5 continues to animate but feel free to add some randomness into exactly how the five are shown each time.

1. The game must not pass any judgement on players, but if a human A wins against human B and human B's Elo score was 100 or more above A's, then A gets a fireworks and a large message congratulations! You just levelled your Elo Rating by X.

# Game Starting Instructions

- Easy Mode means: Radius 2, Depth 3 (C99-based gomoku-httpd Docker Container)
- Intemeriate Mode means: Radius 2, Depth 5 (C99-based gomoku-httpd Docker Container)
- Hard Mode means: Radius 2, Depth 7 (C99-based gomoku-httpd Docker Container)
- Hardest Mode (Premium Game: $1 — Play for free during Beta Testing) Radius 2, Depth 9, (Rust-based gomoku-httpd-rust) Docker Container)

## Biggest Changes

### CHAT Interface

There is a feeling that we went a bit too far and produced some slop with the chat interface intergration from the UX point of view.

It feels like we are reimplimenting the IRC from the 90s.

I do want the two people playing have a way to communicate, and so the only two commands for now supported for now are "/boo @user" and "/like @user".

The /boo maps to the blocks table, while /like maps to the friendship table.

In a game of human vs human, the randomly assigned player to the player A must be from the pool of online available players minus all the ones this particular use blocked.

### Further Feature Changes

- get rid of /invite @user and /woo command

- add total number of players currently online

- add "Play with a Random Unoccupied Online Player Just Below my level"

- add "Play with a Random Unoccupied Onlne Player Just Above my level"

- Everyone starts at Elo Rating 1500

- Elo ranking is then used for each of the completed games and is recorded in the database under a single transaction (subtract from one, add to another).\*

- If there is no one online to choose from the game should catch that corner case and say "No available human players are currently available. Would you like to try the AI?"

- If they say yes, show them the same set of buttons we described above:

  1. I'd like to play vs a computer on Easy Mode
  1. I'd like to play vs a computer on Intermediate Mode
  1. I'd like to play vs a computer on Hard Mode
  1. I'd like to play vs a computer on Hardest Mode (Premium Game: $1 — Play for Free during Beta Testing)

- As soon as a "@user" joined your game — messages window comes to focus in the main window. Inside the message white area two messages appear:

  - "System Message: you can chat here with your opponent @john, can /like @john during the game if you like him, or you can /boo @john which will ban you from ever playing again".

## Implementation

In this Google Run Configuration we must start up either three Docker Images and One Always On Docker Container:

1. Always on single copy for up to 100 connections: the Gomoku API server + static assets just like now.
1. The gomoku-httpd or gomoku-httpd-rust container –— if you wish you can build a single container with both of the binaries inside and simply invoke bin/gomoku-httpd-rust during the "hardest" mode. But you do need to ensure that with Rust in play the container has access to 8 vCPUs.

the C Docker Container (with gomoku-httpd) for playing against the AI at easy, internmediate and hard levels, as well as the gomoku-httpd-rust binary running in a container with 8 vCPUs, and shutting down immediately after the game ends. At that level the game should always be capped to 15 minutes and the backend destroyed after 15 minutes, with a draw result.
